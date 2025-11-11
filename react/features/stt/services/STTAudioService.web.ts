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
    private mediaRecorder: MediaRecorder | null = null;
    private audioStream: MediaStream | null = null;
    private chunkStartTime: number = 0;
    private isRecording: boolean = false;
    private isStopping: boolean = false;
    private processedFinalChunk: boolean = false;
    private store: IStore | null = null;
    private metadata: STTChunkMetadata | null = null;
    private lastChunkSentTime: number = 0; // Track when last chunk was sent

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
     * Converts audio blob to WAV format.
     *
     * @param {Blob} blob - The audio blob to convert.
     * @returns {Promise<Blob>}
     */
    private async convertToWAV(blob: Blob): Promise<Blob> {
        // If already WAV, return as is
        if (blob.type.includes('wav')) {
            return blob;
        }

        // For now, return the blob as is since MediaRecorder typically produces webm/opus
        // In production, you might want to use a library like lamejs or opus-decoder
        // to convert to WAV, but for now we'll let the server handle the conversion
        return blob;
    }

    /**
     * Sends audio chunk to STT API.
     *
     * @param {Blob} audioBlob - The audio chunk to send.
     * @param {STTChunkMetadata} metadata - The metadata for the chunk.
     * @returns {Promise<STTResponse>}
     */
    private async sendChunkToAPI(audioBlob: Blob, metadata: STTChunkMetadata): Promise<STTResponse> {
        const formData = new FormData();
        
        // Convert to WAV if needed
        const wavBlob = await this.convertToWAV(audioBlob);
        formData.append('file', wavBlob, 'audio.wav');
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
            file_type: audioBlob.type
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
     * Handles data available event from MediaRecorder.
     * This is called automatically every CHUNK_DURATION_MS when using timeslice.
     * Also called when requestData() is called or when recording stops.
     *
     * @param {BlobEvent} event - The data available event.
     * @returns {void}
     */
    private handleDataAvailable = async (event: BlobEvent) => {
        if (!event.data || event.data.size === 0 || !this.metadata) {
            return;
        }

        // If we're stopping and we've already processed the final chunk, ignore further events
        if (this.isStopping && this.processedFinalChunk) {
            return;
        }

        // Only send if the chunk has meaningful data (at least 1 second of audio)
        if (event.data.size < 1000) {
            return;
        }

        // Calculate time since last chunk was sent
        const timeSinceLastChunk = this.lastChunkSentTime > 0 
            ? Date.now() - this.lastChunkSentTime 
            : Date.now() - this.chunkStartTime;

        // If this is a regular 30s chunk (from timeslice), use chunkStartTime
        // If this is a final chunk when stopping, use the time since last chunk
        const isRegularChunk = timeSinceLastChunk >= CHUNK_DURATION_MS - 1000; // Allow 1s tolerance

        // Create a copy of metadata with the chunk start timestamp
        const chunkMetadata: STTChunkMetadata = {
            ...this.metadata,
            ts: this.formatTimestamp(new Date(this.chunkStartTime))
        };

        logger.info('Handling audio chunk', {
            size: event.data.size,
            isRegularChunk,
            timeSinceLastChunk: Math.round(timeSinceLastChunk / 1000) + 's',
            chunkStartTime: this.formatTimestamp(new Date(this.chunkStartTime))
        });

        try {
            await this.sendChunkToAPI(event.data, chunkMetadata);
            
            // Update tracking times
            this.lastChunkSentTime = Date.now();
            // If this was during stopping, mark that we've processed the final chunk
            if (this.isStopping) {
                this.processedFinalChunk = true;
            }
            // Update chunk start time for next chunk (if continuing)
            if (isRegularChunk) {
                this.chunkStartTime = Date.now();
            } else {
                // This was a final chunk, chunkStartTime will be reset in cleanup
                this.chunkStartTime = this.lastChunkSentTime;
            }
        } catch (error) {
            logger.error('Failed to send STT chunk', error);
        }
    };

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

        // Initialize MediaRecorder
        const mimeType = MediaRecorder.isTypeSupported('audio/webm') 
            ? 'audio/webm' 
            : MediaRecorder.isTypeSupported('audio/ogg') 
                ? 'audio/ogg' 
                : 'audio/webm'; // fallback

        try {
            this.mediaRecorder = new MediaRecorder(this.audioStream, {
                mimeType,
                audioBitsPerSecond: 128000
            });

            this.mediaRecorder.ondataavailable = this.handleDataAvailable;

            // Start recording with timeslice to automatically get chunks every 30 seconds
            // When timeslice is specified, dataavailable event fires automatically
            // Set chunkStartTime to current time - this is when user started speaking
            this.chunkStartTime = Date.now();
            this.lastChunkSentTime = 0;
            this.mediaRecorder.start(CHUNK_DURATION_MS);
            this.isRecording = true;

            logger.info('STT recording started', {
                meeting_id: this.metadata.meeting_id,
                user_id: this.metadata.user_id,
                role: this.metadata.role,
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

        // Mark stopping and rely on the final dataavailable fired by stop()
        this.isStopping = true;
        this.processedFinalChunk = false;

        // Stop the MediaRecorder
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            // Stop will trigger a final dataavailable event with remaining data
            this.mediaRecorder.stop();
            
            // Wait for the stop event to ensure all data is available
            await new Promise<void>((resolve) => {
                if (this.mediaRecorder) {
                    const onStop = () => {
                        this.mediaRecorder?.removeEventListener('stop', onStop);
                        resolve();
                    };
                    this.mediaRecorder.addEventListener('stop', onStop);
                    
                    // Timeout after 2 seconds
                    setTimeout(() => {
                        this.mediaRecorder?.removeEventListener('stop', onStop);
                        resolve();
                    }, 2000);
                } else {
                    resolve();
                }
            });
        }

        this.cleanup();
        logger.info('STT recording stopped');
    }

    /**
     * Cleans up resources.
     *
     * @returns {void}
     */
    private cleanup(): void {
        if (this.mediaRecorder) {
            this.mediaRecorder.ondataavailable = null;
            if (this.mediaRecorder.state !== 'inactive') {
                try {
                    this.mediaRecorder.stop();
                } catch (e) {
                    // Ignore errors when stopping
                }
            }
            this.mediaRecorder = null;
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

