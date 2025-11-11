import { AnyAction } from 'redux';

import { IStore } from '../app/types';
import { CONFERENCE_LEFT } from '../base/conference/actionTypes';
import { TRACK_ADDED, TRACK_REMOVED } from '../base/tracks/actionTypes';
import { JitsiTrackEvents } from '../base/lib-jitsi-meet';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import { getLocalJitsiAudioTrack } from '../base/tracks/functions';

import STTAudioService from './services/STTAudioService.web';
import logger from './logger';
import { TOGGLE_MEETING_MODE, UPDATE_MEETING_MODE } from '../meeting-mode/actionTypes';

// Store track listeners to clean up later
const trackListeners = new Map<any, () => void>();

// Store pending unmute timeouts to cancel them if track gets muted before delay
const pendingUnmuteTimeouts = new Map<any, NodeJS.Timeout>();

// Delay before starting recording in meeting mode (to allow meeting-mode middleware to process)
const MEETING_MODE_START_DELAY_MS = 500;

// Timeout used when meeting mode toggles on while mic is already unmuted
let meetingModeStartTimeout: NodeJS.Timeout | null = null;

/**
 * Middleware to handle STT audio recording based on mic mute state.
 * Listens to TRACK_MUTE_CHANGED event directly from JitsiLocalTrack.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register((store: IStore) => (next: Function) => (action: AnyAction) => {
    const result = next(action);

    switch (action.type) {
    case TRACK_ADDED: {
        const { track } = action;
        const jitsiTrack = track?.jitsiTrack;

        // Only handle local audio tracks
        if (jitsiTrack && track?.local && jitsiTrack.isAudioTrack() && jitsiTrack.isLocal()) {
            const state = store.getState();
            const meetingModeEnabled = state['features/meeting-mode']?.enabled || false;

            logger.info('Local audio track added, setting up STT mute listener', {
                trackId: jitsiTrack.getId(),
                isMuted: jitsiTrack.isMuted()
            });

            // Create listener function for this track
            const muteChangedListener = () => {
                const isMuted = jitsiTrack.isMuted();
                const state = store.getState();
                const meetingModeEnabled = state['features/meeting-mode']?.enabled || false;

                logger.info('Local audio track mute changed (from JitsiTrack event)', {
                    isMuted,
                    trackId: jitsiTrack.getId(),
                    trackString: jitsiTrack.toString(),
                    meetingModeEnabled
                });

                if (isMuted) {
                    // Cancel any pending unmute timeout
                    const pendingTimeout = pendingUnmuteTimeouts.get(jitsiTrack);
                    if (pendingTimeout) {
                        clearTimeout(pendingTimeout);
                        pendingUnmuteTimeouts.delete(jitsiTrack);
                        logger.info('Cancelled pending STT recording start due to mute');
                    }

                    // Mic muted - stop recording and send remaining chunk
                    if (STTAudioService.isActive()) {
                        logger.info('Mic muted - stopping STT recording and sending remaining chunk');
                        STTAudioService.stopRecording().catch(error => {
                            logger.error('Failed to stop STT recording on mute', error);
                        });
                    }
                } else {
                    if (!meetingModeEnabled) {
                        logger.info('Meeting mode disabled - skipping STT recording start on unmute');
                        return;
                    }

                    // Mic unmuted - start recording
                    if (!STTAudioService.isActive()) {
                        logger.info('Mic unmuted in meeting mode - scheduling STT recording start with delay');
                        
                        // Cancel any existing timeout for this track
                        const existingTimeout = pendingUnmuteTimeouts.get(jitsiTrack);
                        if (existingTimeout) {
                            clearTimeout(existingTimeout);
                        }

                        // Set a timeout to start recording after delay
                        const timeout = setTimeout(() => {
                            pendingUnmuteTimeouts.delete(jitsiTrack);
                            
                            // Double-check that track is still unmuted and recording hasn't started
                            if (!jitsiTrack.isMuted() && !STTAudioService.isActive()) {
                                logger.info('Starting STT recording after meeting mode delay');
                                STTAudioService.startRecording(store).catch(error => {
                                    logger.error('Failed to start STT recording on unmute', error);
                                });
                            } else {
                                logger.info('Skipping STT recording start - track is muted or recording already active');
                            }
                        }, MEETING_MODE_START_DELAY_MS);

                        pendingUnmuteTimeouts.set(jitsiTrack, timeout);
                    }
                }
            };

            // Register listener on the track
            jitsiTrack.on(JitsiTrackEvents.TRACK_MUTE_CHANGED, muteChangedListener);

            // Store listener for cleanup
            trackListeners.set(jitsiTrack, () => {
                jitsiTrack.off(JitsiTrackEvents.TRACK_MUTE_CHANGED, muteChangedListener);
            });

            // If track is already unmuted when added, start recording
            if (meetingModeEnabled && !jitsiTrack.isMuted()) {
                // In meeting mode, add delay
                logger.info('Local audio track is already unmuted when added in meeting mode, scheduling STT recording start with delay');
                const timeout = setTimeout(() => {
                    pendingUnmuteTimeouts.delete(jitsiTrack);
                    if (!jitsiTrack.isMuted() && !STTAudioService.isActive() && (store.getState()['features/meeting-mode']?.enabled || false)) {
                        logger.info('Starting STT recording after meeting mode delay (track add)');
                        STTAudioService.startRecording(store).catch(error => {
                            logger.error('Failed to start STT recording on track add', error);
                        });
                    } else {
                        logger.info('Skipping STT recording start after delay - track muted, recording active, or meeting mode disabled');
                    }
                }, MEETING_MODE_START_DELAY_MS);
                pendingUnmuteTimeouts.set(jitsiTrack, timeout);
            }
        }
        break;
    }

    case TRACK_REMOVED: {
        const { track } = action;
        const jitsiTrack = track?.jitsiTrack;

        // Clean up listener if this is a local audio track
        if (jitsiTrack && track?.local && jitsiTrack.isAudioTrack() && jitsiTrack.isLocal()) {
            const cleanup = trackListeners.get(jitsiTrack);
            if (cleanup) {
                cleanup();
                trackListeners.delete(jitsiTrack);
            }

            // Cancel any pending unmute timeout
            const pendingTimeout = pendingUnmuteTimeouts.get(jitsiTrack);
            if (pendingTimeout) {
                clearTimeout(pendingTimeout);
                pendingUnmuteTimeouts.delete(jitsiTrack);
            }

            // Stop recording if track is removed
            if (STTAudioService.isActive()) {
                logger.info('Local audio track removed - stopping STT recording');
                STTAudioService.stopRecording().catch(error => {
                    logger.error('Failed to stop STT recording on track remove', error);
                });
            }
        }
        break;
    }

    case CONFERENCE_LEFT: {
        // Conference left, stop any active recording and clean up all listeners
        if (STTAudioService.isActive()) {
            logger.info('Conference left - stopping STT recording');
            STTAudioService.stopRecording().catch(error => {
                logger.error('Failed to stop STT recording on conference leave', error);
            });
        }

        // Clean up all track listeners
        trackListeners.forEach(cleanup => cleanup());
        trackListeners.clear();

        // Clean up all pending unmute timeouts
        pendingUnmuteTimeouts.forEach(timeout => clearTimeout(timeout));
        pendingUnmuteTimeouts.clear();

        if (meetingModeStartTimeout) {
            clearTimeout(meetingModeStartTimeout);
            meetingModeStartTimeout = null;
        }
        break;
    }

    case TOGGLE_MEETING_MODE:
    case UPDATE_MEETING_MODE: {
        const state = store.getState();
        const meetingModeEnabled = state['features/meeting-mode']?.enabled || false;
        const audioTrack = getLocalJitsiAudioTrack(state);
        const jitsiTrack = audioTrack ?? undefined;

        if (meetingModeStartTimeout) {
            clearTimeout(meetingModeStartTimeout);
            meetingModeStartTimeout = null;
        }

        if (!meetingModeEnabled) {
            if (STTAudioService.isActive()) {
                logger.info('Meeting mode disabled - stopping active STT recording');
                STTAudioService.stopRecording().catch(error => {
                    logger.error('Failed to stop STT recording on meeting mode disable', error);
                });
            }
            break;
        }

        if (!jitsiTrack || jitsiTrack.isMuted()) {
            logger.info('Meeting mode enabled but local mic is muted - STT recording will start on next unmute');
            break;
        }

        if (STTAudioService.isActive()) {
            logger.info('Meeting mode enabled and STT already active - no action needed');
            break;
        }

        logger.info('Meeting mode enabled with mic unmuted - scheduling STT recording start');
        meetingModeStartTimeout = setTimeout(() => {
            meetingModeStartTimeout = null;
            const latestState = store.getState();
            const latestTrack = getLocalJitsiAudioTrack(latestState);

            if (!latestState['features/meeting-mode']?.enabled) {
                logger.info('Meeting mode disabled before timeout - skipping STT recording start');
                return;
            }

            if (!latestTrack || latestTrack.isMuted()) {
                logger.info('Local mic muted before timeout - skipping STT recording start');
                return;
            }

            if (STTAudioService.isActive()) {
                logger.info('STT recording already active before timeout - skipping start');
                return;
            }

            STTAudioService.startRecording(store).catch(error => {
                logger.error('Failed to start STT recording on meeting mode enable', error);
            });
        }, MEETING_MODE_START_DELAY_MS);
        break;
    }
    }

    return result;
});

