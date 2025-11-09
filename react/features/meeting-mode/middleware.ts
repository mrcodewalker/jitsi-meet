import { AnyAction } from 'redux';
import { TOGGLE_MEETING_MODE, UPDATE_MEETING_MODE, SET_CURRENT_SPEAKER } from './actionTypes';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import { CONFERENCE_JOINED } from '../base/conference/actionTypes';
import { getCurrentConference } from '../base/conference/functions';
import { IJitsiConference } from '../base/conference/reducer';
import { isLocalParticipantModerator, getLocalParticipant, getParticipantDisplayName, getParticipantById, getRemoteParticipants } from '../base/participants/functions';
import { showNotification } from '../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE, NOTIFICATION_TYPE } from '../notifications/constants';
import { PARTICIPANT_UPDATED } from '../base/participants/actionTypes';
import { participantUpdated } from '../base/participants/actions';
import { JitsiConferenceEvents } from '../base/lib-jitsi-meet';
import { IParticipant } from '../base/participants/types';
import { IStore } from '../app/types';
import { muteAllParticipants } from '../video-menu/actions.any';
import { MEDIA_TYPE } from '../base/media/constants';
import { SET_AUDIO_MUTED } from '../base/media/actionTypes';
import { setAudioMuted } from '../base/media/actions';
import { TRACK_UPDATED } from '../base/tracks/actionTypes';
import { isParticipantAudioMuted } from '../base/tracks/functions.any';
import { muteRemoteParticipant } from '../base/participants/actions';

interface IMeetingModeParticipant extends IParticipant {
    meetingMode?: {
        enabled: boolean;
        timestamp: number;
    };
}

/**
 * Mutes all participants including local participant, except those in exclude list.
 * This function bypasses A/V moderation restrictions for meeting mode.
 *
 * @param {IStore} store - The redux store.
 * @param {Array<string>} excludeIds - Array of participant IDs to not mute.
 */
function muteAllParticipantsIncludingLocal(store: IStore, excludeIds: string[] = []) {
    const state = store.getState();
    const localParticipant = getLocalParticipant(state);
    
    // Mute local participant if not in exclude list
    if (localParticipant && !excludeIds.includes(localParticipant.id)) {
        // Force mute local participant, bypassing any restrictions
        store.dispatch(setAudioMuted(true, /* ensureTrack */ true));
    }
    
    // Mute all remote participants
    const remoteParticipants = getRemoteParticipants(state);
    remoteParticipants.forEach((participant, id) => {
        if (!excludeIds.includes(id)) {
            // Force mute remote participant, bypassing moderator restrictions
            store.dispatch(muteRemoteParticipant(id, MEDIA_TYPE.AUDIO));
        }
    });
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
        const isUserModerator = isLocalParticipantModerator(state);
        const currentEnabled = state['features/meeting-mode']?.enabled || false;
        
        // Only moderators can toggle meeting mode
        if (!isUserModerator) {
            console.warn('Non-moderator tried to toggle meeting mode');
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
                // Mute all participants except the moderator who enabled meeting mode
                const moderatorId = localParticipant?.id;
                muteAllParticipantsIncludingLocal(store, moderatorId ? [moderatorId] : []);
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
            store.dispatch(showNotification({
                titleKey: 'notify.meetingModeEnabled',
                descriptionKey: 'notify.meetingModeActive',
                appearance: NOTIFICATION_TYPE.NORMAL
            }, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));
        } else {
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
        
        // If someone is unmuting (muted = false), mute everyone else
        if (!muted && localParticipant) {
            const currentSpeaker = state['features/meeting-mode']?.currentSpeaker;
            
            // Only proceed if this is a new speaker or no current speaker
            if (currentSpeaker !== localParticipant.id) {
                // Mute all participants except the current speaker
                const excludeIds = [localParticipant.id];
                muteAllParticipantsIncludingLocal(store, excludeIds);
                
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
            }
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

        // Check if this participant just unmuted
        const isNowMuted = track.muted;
        
        // If participant just unmuted (track is not muted)
        if (!isNowMuted) {
            const currentSpeaker = state['features/meeting-mode']?.currentSpeaker;
            
            // Only proceed if this is a new speaker or no current speaker
            if (currentSpeaker !== participantId) {
                // Mute all participants except the current speaker
                const excludeIds = [participantId];
                muteAllParticipantsIncludingLocal(store, excludeIds);
                
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
        }

        return next(action);
    }

    }

    return next(action);
});
