import { IStore } from '../../app/types';
import { getRoomName } from '../../base/conference/functions';
import { getLocalJitsiAudioTrack } from '../../base/tracks/functions.any';
import { getLocalParticipant } from '../../base/participants/functions';
import logger from '../logger';

const STT_API_URL = 'https://api.kma-legend.fun/api/stt_input';
const CHUNK_DURATION_MS = 30000; // 30 seconds

interface STTChunkMetadata {
    meeting_id: string;
    user_id: string;
    full_name?: string;
    role?: string;
    ts?: string;
}

interface STTResponse {
    status: string;
    job_id: string;
    meeting_id: string;
    user_id: string;
}

/**
 * Service to handle STT audio recording and chunking.
 */
class STTAudioService {
    private audioStream: MediaStream | null = null;
    private audioContext: AudioContext | null = null;
    private audioWorkletNode: AudioWorkletNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private chunkStartTime: number = 0;
    private isRecording: boolean = false;
    private isStopping: boolean = false;
    private processedFinalChunk: boolean = false;
    private store: IStore | null = null;
    private metadata: STTChunkMetadata | null = null;
    private lastChunkSentTime: number = 0; // Track when last chunk was sent
    private chunkInterval: number | null = null; // Interval for sending chunks
    private audioBuffers: Float32Array[] = []; // Buffer to accumulate audio data
    private sampleRate: number = 48000; // Default sample rate
    private numChannels: number = 1; // Default mono

    /**
     * Formats timestamp to "YYYY-MM-DD HH:MM:SS" format.
     *
     * @param {Date} date - The date to format.
     * @returns {string}
     */
    private formatTimestamp(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    /**
     * Creates WAV file header from PCM audio data.
     *
     * @param {number} length - Length of PCM data in bytes.
     * @param {number} sampleRate - Sample rate (e.g., 48000).
     * @param {number} numChannels - Number of audio channels (1 = mono, 2 = stereo).
     * @param {number} bitsPerSample - Bits per sample (16 or 32).
     * @returns {ArrayBuffer} WAV header.
     */
    private createWAVHeader(length: number, sampleRate: number, numChannels: number, bitsPerSample: number): ArrayBuffer {
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataSize = length;
        const fileSize = 36 + dataSize;

        const buffer = new ArrayBuffer(44);
        const view = new DataView(buffer);

        // RIFF header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, fileSize, true);
        this.writeString(view, 8, 'WAVE');

        // fmt chunk
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // fmt chunk size
        view.setUint16(20, 1, true); // audio format (1 = PCM)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);

        // data chunk
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        return buffer;
    }

    /**
     * Writes a string to DataView at specified offset.
     *
     * @param {DataView} view - The DataView to write to.
     * @param {number} offset - The offset to write at.
     * @param {string} string - The string to write.
     * @returns {void}
     */
    private writeString(view: DataView, offset: number, string: string): void {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    /**
     * Converts Float32Array audio data to Int16Array (16-bit PCM).
     *
     * @param {Float32Array} float32Array - The float audio data.
     * @returns {Int16Array} The 16-bit PCM audio data.
     */
    private floatTo16BitPCM(float32Array: Float32Array): Int16Array {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            // Clamp value to [-1, 1] range and convert to 16-bit integer
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }

    /**
     * Converts Float32Array audio data to WAV blob.
     *
     * @param {Float32Array[]} audioBuffers - Array of Float32Array audio data (one per channel).
     * @param {number} sampleRate - Sample rate.
     * @returns {Blob} WAV format blob.
     */
    private convertBuffersToWAV(audioBuffers: Float32Array[], sampleRate: number): Blob {
        const numChannels = audioBuffers.length;
        const length = audioBuffers[0].length;
        
        // Convert to 16-bit PCM
        let pcmData: Int16Array;
        
        if (numChannels === 1) {
            // Mono: just convert the single channel
            pcmData = this.floatTo16BitPCM(audioBuffers[0]);
        } else {
            // Stereo: interleave left and right channels
            pcmData = new Int16Array(length * numChannels);
            
            for (let i = 0; i < length; i++) {
                // Convert float samples to 16-bit PCM and interleave
                const leftSample = Math.max(-1, Math.min(1, audioBuffers[0][i]));
                const rightSample = Math.max(-1, Math.min(1, audioBuffers[1][i]));
                pcmData[i * 2] = leftSample < 0 ? leftSample * 0x8000 : leftSample * 0x7FFF;
                pcmData[i * 2 + 1] = rightSample < 0 ? rightSample * 0x8000 : rightSample * 0x7FFF;
            }
        }
        
        // Create WAV header
        const wavHeader = this.createWAVHeader(
            pcmData.length * 2, // length in bytes (Int16 = 2 bytes per sample)
            sampleRate,
            numChannels,
            16 // 16-bit PCM
        );
        
        // Convert Int16Array to Uint8Array for Blob compatibility
        const pcmBuffer = new ArrayBuffer(pcmData.length * 2);
        const pcmView = new Int16Array(pcmBuffer);
        pcmView.set(pcmData);
        const pcmUint8 = new Uint8Array(pcmBuffer);
        
        // Combine header and PCM data
        return new Blob([wavHeader, pcmUint8], { type: 'audio/wav' });
    }

    /**
     * Processes accumulated audio buffers and sends as WAV chunk.
     *
     * @returns {Promise<void>}
     */
    private async processAndSendChunk(): Promise<void> {
        if (!this.metadata || this.audioBuffers.length === 0) {
            return;
        }

        // Get the first buffer to determine length
        const length = this.audioBuffers[0].length;
        
        // Only send if we have meaningful data (at least 1 second of audio)
        const minSamples = this.sampleRate; // 1 second
        if (length < minSamples) {
            return;
        }

        // Create a copy of buffers for processing
        const buffersToProcess = this.audioBuffers.map(buffer => buffer.slice());
        
        // Clear buffers for next chunk
        this.audioBuffers = this.audioBuffers.map(() => new Float32Array(0));

        // Convert to WAV
        const wavBlob = this.convertBuffersToWAV(buffersToProcess, this.sampleRate);

        // Create metadata with chunk start timestamp
        const chunkMetadata: STTChunkMetadata = {
            ...this.metadata,
            ts: this.formatTimestamp(new Date(this.chunkStartTime))
        };

        logger.info('Processing audio chunk', {
            wav_size: wavBlob.size,
            sample_rate: this.sampleRate,
            channels: this.numChannels,
            duration: length / this.sampleRate,
            chunkStartTime: this.formatTimestamp(new Date(this.chunkStartTime))
        });

        try {
            await this.sendChunkToAPI(wavBlob, chunkMetadata);
            
            // Update tracking times
            this.lastChunkSentTime = Date.now();
            this.chunkStartTime = Date.now();
        } catch (error) {
            logger.error('Failed to send STT chunk', error);
        }
    }

    /**
     * Handles audio data from ScriptProcessorNode.
     *
     * @param {AudioProcessingEvent} event - The audio processing event.
     * @returns {void}
     */
    private handleAudioProcess = (event: AudioProcessingEvent) => {
        if (!this.isRecording) {
            return;
        }

        const inputBuffer = event.inputBuffer;
        const numberOfChannels = inputBuffer.numberOfChannels;
        const bufferLength = inputBuffer.length;

        // Update numChannels from actual audio data (more accurate than track settings)
        if (this.numChannels !== numberOfChannels) {
            this.numChannels = numberOfChannels;
            // Reset buffers if channel count changed
            this.audioBuffers = [];
        }

        // Initialize buffers if needed
        if (this.audioBuffers.length === 0) {
            this.audioBuffers = Array.from({ length: numberOfChannels }, () => new Float32Array(0));
        }

        // Append new audio data to buffers
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const inputData = inputBuffer.getChannelData(channel);
            const currentBuffer = this.audioBuffers[channel];
            const newBuffer = new Float32Array(currentBuffer.length + bufferLength);
            newBuffer.set(currentBuffer);
            newBuffer.set(inputData, currentBuffer.length);
            this.audioBuffers[channel] = newBuffer;
        }
    };

    /**
     * Sends audio chunk to STT API.
     *
     * @param {Blob} audioBlob - The audio chunk to send (should already be WAV).
     * @param {STTChunkMetadata} metadata - The metadata for the chunk.
     * @returns {Promise<STTResponse>}
     */
    private async sendChunkToAPI(audioBlob: Blob, metadata: STTChunkMetadata): Promise<STTResponse> {
        const formData = new FormData();
        
        // Audio blob should already be WAV format
        formData.append('file', audioBlob, 'audio.wav');
        formData.append('meeting_id', metadata.meeting_id);
        formData.append('user_id', metadata.user_id);
        
        if (metadata.full_name) {
            formData.append('full_name', metadata.full_name);
        }
        
        if (metadata.role) {
            formData.append('role', metadata.role);
        }
        
        if (metadata.ts) {
            formData.append('ts', metadata.ts);
        }

        // Log the data being sent for debugging
        logger.info('Sending STT chunk to API', {
            meeting_id: metadata.meeting_id,
            user_id: metadata.user_id,
            full_name: metadata.full_name,
            role: metadata.role,
            ts: metadata.ts,
            file_size: audioBlob.size,
            file_type: audioBlob.type,
            is_wav: audioBlob.type === 'audio/wav'
        });

        try {
            const response = await fetch(STT_API_URL, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                throw new Error(`STT API error: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const result: STTResponse = await response.json();
            logger.info('STT chunk sent successfully', { 
                job_id: result.job_id,
                meeting_id: result.meeting_id,
                user_id: result.user_id,
                status: result.status
            });
            
            return result;
        } catch (error) {
            logger.error('Failed to send STT chunk', {
                error,
                meeting_id: metadata.meeting_id,
                user_id: metadata.user_id,
                ts: metadata.ts
            });
            throw error;
        }
    }


    /**
     * Gets meeting response from localStorage.
     *
     * @returns {any|null}
     */
    private getMeetingResponseFromStorage(): any | null {
        try {
            const meetingResponseStr = typeof window !== 'undefined' 
                ? window.localStorage.getItem('meetingResponse') 
                : null;
            
            if (!meetingResponseStr) {
                return null;
            }

            return JSON.parse(meetingResponseStr);
        } catch (error) {
            logger.error('Failed to parse meetingResponse from localStorage', error);
            return null;
        }
    }

    /**
     * Starts recording audio for STT.
     *
     * @param {IStore} store - The Redux store.
     * @returns {Promise<void>}
     */
    async startRecording(store: IStore): Promise<void> {
        if (this.isRecording) {
            logger.warn('STT recording already in progress');
            return;
        }

        const state = store.getState();
        const audioTrack = getLocalJitsiAudioTrack(state);
        const localParticipant = getLocalParticipant(state);
        const roomName = getRoomName(state);

        if (!audioTrack || !localParticipant || !roomName) {
            logger.warn('Cannot start STT recording: missing audio track, participant, or room name');
            return;
        }

        // Get the underlying MediaStreamTrack
        const mediaStreamTrack = audioTrack.track;

        if (!mediaStreamTrack || mediaStreamTrack.readyState !== 'live') {
            logger.warn('Cannot start STT recording: audio track is not live');
            return;
        }

        // Get meeting response from localStorage
        const meetingResponse = this.getMeetingResponseFromStorage();
        
        // Extract metadata from meetingResponse or fallback to participant data
        let user_id: string;
        let full_name: string | undefined;
        let role: string | undefined;

        if (meetingResponse?.user) {
            // Use user info from meetingResponse
            user_id = String(meetingResponse.user.id);
            full_name = meetingResponse.user.name;
            // Use meetingRole from meeting object
            role = meetingResponse.meeting?.meetingRole;
        } else {
            // Fallback to participant data
            user_id = localParticipant.id;
            full_name = localParticipant.name;
            role = localParticipant.role;
            logger.warn('meetingResponse not found in localStorage, using participant data');
        }

        this.store = store;
        this.audioStream = new MediaStream([mediaStreamTrack]);
        
        // Get metadata
        const meetingId = meetingResponse?.meeting?.id
            ? String(meetingResponse.meeting.id)
            : roomName;

        this.metadata = {
            meeting_id: meetingId,
            user_id,
            full_name,
            role
        };

        try {
            // Create AudioContext for direct audio processing
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            this.sampleRate = this.audioContext.sampleRate;
            
            // Create source node from audio stream
            this.sourceNode = this.audioContext.createMediaStreamSource(this.audioStream);
            
            // Detect number of channels from audio stream
            // Most audio streams are mono, but we'll support stereo too
            const audioTrack = this.audioStream.getAudioTracks()[0];
            const channelCount = audioTrack.getSettings().channelCount || 1;
            this.numChannels = Math.min(channelCount, 2); // Limit to mono or stereo
            
            // Use ScriptProcessorNode for audio processing (deprecated but widely supported)
            // Buffer size of 4096 provides good balance between latency and performance
            const bufferSize = 4096;
            const scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, this.numChannels, this.numChannels);
            
            scriptProcessor.onaudioprocess = this.handleAudioProcess;
            
            // Create a silent destination to avoid playing audio
            // ScriptProcessorNode needs to be connected to keep processing
            const silentDestination = this.audioContext.createGain();
            silentDestination.gain.value = 0; // Mute output
            
            // Connect source to script processor to silent destination
            this.sourceNode.connect(scriptProcessor);
            scriptProcessor.connect(silentDestination);
            silentDestination.connect(this.audioContext.destination);
            
            // Store reference for cleanup
            this.audioWorkletNode = scriptProcessor as any;
            
            // Initialize audio buffers
            this.audioBuffers = [];
            
            // Set chunkStartTime to current time
            this.chunkStartTime = Date.now();
            this.lastChunkSentTime = 0;
            
            // Start interval to send chunks every 30 seconds
            this.chunkInterval = window.setInterval(() => {
                this.processAndSendChunk();
            }, CHUNK_DURATION_MS);
            
            this.isRecording = true;

            logger.info('STT recording started', {
                meeting_id: this.metadata.meeting_id,
                user_id: this.metadata.user_id,
                role: this.metadata.role,
                sample_rate: this.sampleRate,
                chunk_start_time: this.formatTimestamp(new Date(this.chunkStartTime))
            });
        } catch (error) {
            logger.error('Failed to start STT recording', error);
            this.cleanup();
            throw error;
        }
    }

    /**
     * Stops recording and sends the remaining chunk.
     *
     * @returns {Promise<void>}
     */
    async stopRecording(): Promise<void> {
        if (!this.isRecording) {
            return;
        }

        // Mark stopping
        this.isStopping = true;

        // Clear interval
        if (this.chunkInterval !== null) {
            clearInterval(this.chunkInterval);
            this.chunkInterval = null;
        }

        // Process and send final chunk with remaining audio data
        await this.processAndSendChunk();

        this.cleanup();
        logger.info('STT recording stopped');
    }

    /**
     * Cleans up resources.
     *
     * @returns {void}
     */
    private cleanup(): void {
        // Clear interval
        if (this.chunkInterval !== null) {
            clearInterval(this.chunkInterval);
            this.chunkInterval = null;
        }

        // Disconnect audio nodes
        if (this.audioWorkletNode) {
            try {
                this.audioWorkletNode.disconnect();
            } catch (e) {
                // Ignore errors
            }
            this.audioWorkletNode = null;
        }

        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch (e) {
                // Ignore errors
            }
            this.sourceNode = null;
        }

        // Close audio context
        if (this.audioContext) {
            this.audioContext.close().catch(() => {
                // Ignore errors when closing
            });
            this.audioContext = null;
        }

        if (this.audioStream) {
            // Don't stop the tracks as they're still being used by the conference
            this.audioStream = null;
        }

        this.isRecording = false;
        this.isStopping = false;
        this.processedFinalChunk = false;
        this.store = null;
        this.metadata = null;
        this.chunkStartTime = 0;
        this.lastChunkSentTime = 0;
        this.audioBuffers = [];
        this.sampleRate = 48000;
        this.numChannels = 1;
    }

    /**
     * Checks if recording is currently active.
     *
     * @returns {boolean}
     */
    isActive(): boolean {
        return this.isRecording;
    }
}

// Export singleton instance
export default new STTAudioService();

