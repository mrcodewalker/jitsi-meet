import { AnyAction } from 'redux';
import { TOGGLE_MEETING_MODE, UPDATE_MEETING_MODE, SET_CURRENT_SPEAKER } from './actionTypes';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import { CONFERENCE_JOINED } from '../base/conference/actionTypes';
import { getCurrentConference } from '../base/conference/functions';
import { IJitsiConference } from '../base/conference/reducer';
import { isLocalParticipantModerator, getLocalParticipant, getParticipantDisplayName, getParticipantById, getRemoteParticipants, isParticipantModerator } from '../base/participants/functions';
import { isLocalParticipantApprovedFromState, isParticipantApproved } from '../av-moderation/functions';
import { showNotification } from '../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE, NOTIFICATION_TYPE } from '../notifications/constants';
import { PARTICIPANT_UPDATED } from '../base/participants/actionTypes';
import { participantUpdated } from '../base/participants/actions';
import { JitsiConferenceEvents } from '../base/lib-jitsi-meet';
import { IParticipant } from '../base/participants/types';
import { IStore } from '../app/types';
import { muteAllParticipantsIncludingLocal as dispatchMuteAllParticipantsIncludingLocal } from '../video-menu/actions.any';
import { MEDIA_TYPE } from '../base/media/constants';
import { MEDIA_TYPE as AVM_MEDIA_TYPE } from '../av-moderation/constants';
import { SET_AUDIO_MUTED } from '../base/media/actionTypes';
import { setAudioMuted } from '../base/media/actions';
import { TRACK_UPDATED } from '../base/tracks/actionTypes';
import { isParticipantAudioMuted } from '../base/tracks/functions.any';
import { muteRemoteParticipant } from '../base/participants/actions';
import { requestEnableAudioModeration, requestDisableAudioModeration } from '../av-moderation/actions';

interface IMeetingModeParticipant extends IParticipant {
    meetingMode?: {
        enabled: boolean;
        timestamp: number;
    };
}

/**
 * Checks if anyone else (other than the specified participant) is currently speaking (unmuted).
 *
 * @param {IStore} store - The redux store.
 * @param {string} excludeParticipantId - The participant ID to exclude from the check.
 * @returns {boolean} - True if someone else is speaking, false otherwise.
 */
function isAnyoneElseSpeaking(store: IStore, excludeParticipantId: string): boolean {
    const state = store.getState();
    const localParticipant = getLocalParticipant(state);
    const remoteParticipants = getRemoteParticipants(state);
    
    // Check local participant
    if (localParticipant && localParticipant.id !== excludeParticipantId) {
        if (!isParticipantAudioMuted(localParticipant, state)) {
            return true;
        }
    }
    
    // Check remote participants
    for (const [id, participant] of remoteParticipants) {
        if (id !== excludeParticipantId && !isParticipantAudioMuted(participant, state)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Dispatches the global mute-all thunk with the provided exclusions.
 *
 * @param {IStore} store - The redux store.
 * @param {Array<string>} excludeIds - Participant IDs that should remain unmuted.
 * @returns {void}
 */
function forceMuteAllParticipants(store: IStore, excludeIds: string[] = []) {
    store.dispatch(dispatchMuteAllParticipantsIncludingLocal(excludeIds, MEDIA_TYPE.AUDIO));
}


/**
 * The redux middleware for the meeting mode feature.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(store => next => (action: AnyAction) => {
    switch (action.type) {
    case CONFERENCE_JOINED: {
        // Meeting mode property is already handled by base participants middleware
        break;
    }

    case PARTICIPANT_UPDATED: {
        const { participant } = action;
        
        // Handle meeting mode updates from base participants middleware
        // Only update state if this is from a remote participant (not local)
        if (participant?.meetingMode && !participant.local) {
            const { enabled, timestamp } = participant.meetingMode;
            
            // Update meeting mode state using UPDATE_MEETING_MODE to avoid infinite loop
            store.dispatch({
                type: UPDATE_MEETING_MODE,
                enabled,
                timestamp
            });
        }
        break;
    }

    case TOGGLE_MEETING_MODE: {
        const state = store.getState();
        const conference = getCurrentConference(state);
        
        // Check if local participant is ADMIN (meetingRole) - only ADMIN can toggle meeting mode
        let isAdmin = false;
        try {
            isAdmin = (typeof window !== 'undefined')
                && window?.localStorage?.getItem('meetingRole') === 'ADMIN';
        } catch (e) {
            isAdmin = false;
        }
        
        const currentEnabled = state['features/meeting-mode']?.enabled || false;
        
        // Only ADMIN can toggle meeting mode
        if (!isAdmin) {
            console.warn('Non-ADMIN tried to toggle meeting mode');
            return next(action);
        }

        const newEnabled = !currentEnabled;
        const timestamp = newEnabled ? Date.now() : 0;
        const localParticipant = getLocalParticipant(state);

        // Update local participant state first
        store.dispatch(participantUpdated({
            id: localParticipant?.id ?? '',
            local: true,
            meetingMode: {
                enabled: newEnabled,
                timestamp
            }
        } as IMeetingModeParticipant));

        // Set the property to broadcast to other participants
        if (conference) {
            // Send JSON string to match what base participants middleware expects
            const meetingModeData = {
                enabled: newEnabled,
                timestamp
            };
            conference.setLocalParticipantProperty('meetingMode', JSON.stringify(meetingModeData));

            // Mute all participants when meeting mode is enabled
            if (newEnabled) {
                // Mute all participants (including ADMIN/moderators)
                forceMuteAllParticipants(store, []);
                
                // Enable AV moderation so users need approval to unmute
                // This ensures that in meeting mode, users cannot unmute themselves without approval
                store.dispatch(requestEnableAudioModeration());
            } else {
                // When meeting mode is disabled, clear current speaker and allow everyone to unmute freely
                store.dispatch({
                    type: SET_CURRENT_SPEAKER,
                    speakerId: null
                });
                
                // Disable AV moderation to allow free unmute
                store.dispatch(requestDisableAudioModeration());
            }

            // External API notification can be added here if needed

            // Show notification for the moderator who made the change
            const moderatorName = getParticipantDisplayName(state, localParticipant?.id ?? '');
            store.dispatch(showNotification({
                title: moderatorName,
                titleKey: newEnabled ? 'notify.meetingModeEnabledBy' : 'notify.meetingModeDisabledBy',
                descriptionKey: newEnabled ? 'notify.meetingModeActive' : 'notify.meetingModeInactive',
                appearance: NOTIFICATION_TYPE.NORMAL
            }, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));
        } 

        // Update the state
        return next({
            type: TOGGLE_MEETING_MODE,
            enabled: newEnabled,
            timestamp
        });
    }

    case UPDATE_MEETING_MODE: {
        const result = next(action);
        const state = store.getState();
        const { enabled } = action;
        
        // Show notification to all participants when meeting mode state changes
        if (enabled) {
            // When meeting mode is enabled remotely, mute all participants
            forceMuteAllParticipants(store, []);
            
            // Enable AV moderation so users need approval to unmute
            store.dispatch(requestEnableAudioModeration());
            
            store.dispatch(showNotification({
                titleKey: 'notify.meetingModeEnabled',
                descriptionKey: 'notify.meetingModeActive',
                appearance: NOTIFICATION_TYPE.NORMAL
            }, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));
        } else {
            // When meeting mode is disabled, clear current speaker to allow free unmute
            store.dispatch({
                type: SET_CURRENT_SPEAKER,
                speakerId: null
            });
            
            // Disable AV moderation to allow free unmute
            store.dispatch(requestDisableAudioModeration());
            
            store.dispatch(showNotification({
                titleKey: 'notify.meetingModeDisabled',
                descriptionKey: 'notify.meetingModeInactive',
                appearance: NOTIFICATION_TYPE.NORMAL
            }, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));
        }
        
        return result;
    }

    case SET_AUDIO_MUTED: {
        const state = store.getState();
        const meetingModeEnabled = state['features/meeting-mode']?.enabled || false;
        
        // Only apply single speaker logic when meeting mode is enabled
        if (!meetingModeEnabled) {
            return next(action);
        }

        const { muted } = action;
        const localParticipant = getLocalParticipant(state);
        const currentSpeaker = state['features/meeting-mode']?.currentSpeaker;
        
        // If someone is muting themselves and they were the current speaker, clear current speaker
        if (muted && localParticipant && currentSpeaker === localParticipant.id) {
            store.dispatch({
                type: SET_CURRENT_SPEAKER,
                speakerId: null
            });
        }
        
        // If someone is trying to unmute (muted = false)
        if (!muted && localParticipant) {
            // Check if local participant is ADMIN or moderator
            let isLocalAdmin = false;
            try {
                isLocalAdmin = (typeof window !== 'undefined')
                    && window?.localStorage?.getItem('meetingRole') === 'ADMIN';
            } catch (e) {
                isLocalAdmin = false;
            }
            const isLocalModerator = isLocalParticipantModerator(state);
            const isAdminOrModerator = isLocalAdmin || isLocalModerator;
            
            // Prevent spam unmute - cooldown of 2 seconds
            // This prevents users from spamming unmute to steal mic from current speaker
            const lastUnmuteTime = state['features/meeting-mode']?.lastUnmuteTime || 0;
            const now = Date.now();
            const timeSinceLastUnmute = now - lastUnmuteTime;
            const UNMUTE_COOLDOWN_MS = 2000; // 2 seconds cooldown
            
            // ADMIN can always unmute (no cooldown)
            // But for others, check cooldown if someone else is speaking
            const currentSpeaker = state['features/meeting-mode']?.currentSpeaker;
            const isAnyoneElseSpeakingNow = isAnyoneElseSpeaking(store, localParticipant.id);
            
            // Apply cooldown if:
            // 1. Not ADMIN
            // 2. Someone else is currently speaking
            // 3. Last unmute was less than 2 seconds ago
            if (!isLocalAdmin && isAnyoneElseSpeakingNow && timeSinceLastUnmute < UNMUTE_COOLDOWN_MS) {
                // Too soon since last unmute, prevent spam
                store.dispatch(showNotification({
                    titleKey: 'notify.unmuteCooldown',
                    descriptionKey: 'notify.waitBeforeUnmute',
                    appearance: NOTIFICATION_TYPE.WARNING
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
                
                // Force mute back
                store.dispatch(setAudioMuted(true, /* ensureTrack */ true));
                return next(action);
            }
            
            // ADMIN (meetingRole) has highest priority - can always unmute, even if other moderators are speaking
            // Regular moderators and users must follow single speaker rules
            if (isLocalAdmin) {
                // ADMIN can always unmute - mute everyone else including other moderators
                const excludeIds = [localParticipant.id];
                
                // Don't exclude other moderators - ADMIN has priority
                // This ensures ADMIN can unmute even when other moderators are speaking
                
                forceMuteAllParticipants(store, excludeIds);
                
                // Update current speaker
                store.dispatch({
                    type: SET_CURRENT_SPEAKER,
                    speakerId: localParticipant.id
                });
                
                // Show notification about single speaker mode
                const speakerName = getParticipantDisplayName(state, localParticipant.id);
                store.dispatch(showNotification({
                    title: speakerName,
                    titleKey: 'notify.singleSpeakerMode',
                    descriptionKey: 'notify.singleSpeakerModeDescription',
                    appearance: NOTIFICATION_TYPE.NORMAL
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
                
                return next(action);
            }
            
            // In meeting mode, everyone (except ADMIN) needs approval or raise hand to unmute
            // Check if there's a current speaker and it's not this participant
            // Also check if anyone else is actually speaking (unmuted)
            if (currentSpeaker && currentSpeaker !== localParticipant.id) {
                // There's already a current speaker, check if they're still speaking
                if (isAnyoneElseSpeaking(store, localParticipant.id)) {
                    // Someone else is already speaking, prevent unmuting and show notification
                    store.dispatch(showNotification({
                        titleKey: 'notify.someoneElseSpeaking',
                        descriptionKey: 'notify.waitForTurnToSpeak',
                        appearance: NOTIFICATION_TYPE.WARNING
                    }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
                    
                    // Force mute back
                    store.dispatch(setAudioMuted(true, /* ensureTrack */ true));
                    return next(action);
                }
            } else if (isAnyoneElseSpeaking(store, localParticipant.id)) {
                // No current speaker set but someone else is actually speaking
                // Prevent unmuting and show notification
                store.dispatch(showNotification({
                    titleKey: 'notify.someoneElseSpeaking',
                    descriptionKey: 'notify.waitForTurnToSpeak',
                    appearance: NOTIFICATION_TYPE.WARNING
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
                
                // Force mute back
                store.dispatch(setAudioMuted(true, /* ensureTrack */ true));
                return next(action);
            }
            
            // Check if participant has been approved to unmute (via ADMIN approval) or has raised hand
            // In meeting mode, everyone (except ADMIN) must either be approved by ADMIN or have raised hand
            const isApproved = isLocalParticipantApprovedFromState(AVM_MEDIA_TYPE.AUDIO, state);
            const hasRaisedHand = localParticipant.raisedHandTimestamp && localParticipant.raisedHandTimestamp > 0;
            
            if (!isApproved && !hasRaisedHand) {
                // User tried to unmute without approval or raising hand - prevent and show notification
                store.dispatch(showNotification({
                    titleKey: 'notify.meetingModeActive',
                    descriptionKey: 'notify.raiseHandToUnmute',
                    appearance: NOTIFICATION_TYPE.WARNING
                }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
                
                // Force mute back
                store.dispatch(setAudioMuted(true, /* ensureTrack */ true));
                return next(action);
            }
            
            // Allow unmuting - user has been approved or raised hand
            // Mute everyone else to ensure only one speaker at a time
            const excludeIds = [localParticipant.id];
            
            forceMuteAllParticipants(store, excludeIds);
            
            // Update current speaker and last unmute time
            store.dispatch({
                type: SET_CURRENT_SPEAKER,
                speakerId: localParticipant.id
            });
            
            // Show notification about single speaker mode
            const speakerName = getParticipantDisplayName(state, localParticipant.id);
            store.dispatch(showNotification({
                title: speakerName,
                titleKey: 'notify.singleSpeakerMode',
                descriptionKey: 'notify.singleSpeakerModeDescription',
                appearance: NOTIFICATION_TYPE.NORMAL
            }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
        }

        return next(action);
    }

    case TRACK_UPDATED: {
        const state = store.getState();
        const meetingModeEnabled = state['features/meeting-mode']?.enabled || false;
        
        // Only apply single speaker logic when meeting mode is enabled
        if (!meetingModeEnabled) {
            return next(action);
        }

        const { track } = action;
        const { jitsiTrack } = track;
        
        // Only handle audio tracks
        if (jitsiTrack.getType() !== MEDIA_TYPE.AUDIO) {
            return next(action);
        }

        const participantId = jitsiTrack.getParticipantId();
        const isLocal = jitsiTrack.isLocal();
        
        // Skip if this is a local track (handled by SET_AUDIO_MUTED)
        if (isLocal) {
            return next(action);
        }

        // Check if this participant just muted or unmuted
        const isNowMuted = track.muted;
        const currentSpeaker = state['features/meeting-mode']?.currentSpeaker;
        
        // If participant just muted themselves and they were the current speaker, clear current speaker
        if (isNowMuted && currentSpeaker === participantId) {
            store.dispatch({
                type: SET_CURRENT_SPEAKER,
                speakerId: null
            });
            return next(action);
        }
        
        // If participant just unmuted (track is not muted)
        if (!isNowMuted) {
            // In meeting mode, all remote participants (including moderators) need approval or raise hand to unmute
            // Only ADMIN can unmute directly
            const participant = getParticipantById(state, participantId);
            const hasRaisedHand = participant?.raisedHandTimestamp && participant.raisedHandTimestamp > 0;
            const isApproved = isParticipantApproved(participantId, AVM_MEDIA_TYPE.AUDIO)(state);
            
            // Check if participant has been approved or has raised hand
            if (!isApproved && !hasRaisedHand) {
                // Remote participant tried to unmute without approval or raising hand - mute them back
                store.dispatch(muteRemoteParticipant(participantId, MEDIA_TYPE.AUDIO));
                return next(action);
            }
            
            // Prevent spam unmute - cooldown of 2 seconds for remote participants too
            const lastUnmuteTime = state['features/meeting-mode']?.lastUnmuteTime || 0;
            const now = Date.now();
            const timeSinceLastUnmute = now - lastUnmuteTime;
            const UNMUTE_COOLDOWN_MS = 2000; // 2 seconds cooldown
            const isAnyoneElseSpeakingNow = isAnyoneElseSpeaking(store, participantId);
            
            // Apply cooldown if someone else is speaking and last unmute was less than 2 seconds ago
            if (isAnyoneElseSpeakingNow && timeSinceLastUnmute < UNMUTE_COOLDOWN_MS) {
                // Too soon since last unmute, prevent spam - mute this participant
                store.dispatch(muteRemoteParticipant(participantId, MEDIA_TYPE.AUDIO));
                return next(action);
            }
            
            // Check if there's a current speaker and it's not this participant
            // Also check if anyone else is actually speaking (unmuted)
            if (currentSpeaker && currentSpeaker !== participantId) {
                // There's already a current speaker, check if they're still speaking
                if (isAnyoneElseSpeaking(store, participantId)) {
                    // Someone else is already speaking, mute this participant
                    store.dispatch(muteRemoteParticipant(participantId, MEDIA_TYPE.AUDIO));
                    return next(action);
                }
            } else if (isAnyoneElseSpeaking(store, participantId)) {
                // No current speaker set but someone else is actually speaking
                // Mute this participant
                store.dispatch(muteRemoteParticipant(participantId, MEDIA_TYPE.AUDIO));
                return next(action);
            }
            
            // No one else is speaking and participant has been approved or raised hand, allow this participant to speak
            // Mute everyone else to ensure only one speaker at a time
            const excludeIds = [participantId];
            
            forceMuteAllParticipants(store, excludeIds);
            
            // Update current speaker
            store.dispatch({
                type: SET_CURRENT_SPEAKER,
                speakerId: participantId
            });
            
            // Show notification about single speaker mode
            const speakerName = getParticipantDisplayName(state, participantId);
            store.dispatch(showNotification({
                title: speakerName,
                titleKey: 'notify.singleSpeakerMode',
                descriptionKey: 'notify.singleSpeakerModeDescription',
                appearance: NOTIFICATION_TYPE.NORMAL
            }, NOTIFICATION_TIMEOUT_TYPE.SHORT));
        }

        return next(action);
    }

    }

    return next(action);
});
