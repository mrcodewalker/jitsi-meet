import {
    AUDIO_MUTE,
    DESKTOP_MUTE,
    VIDEO_MUTE,
    createRemoteMuteConfirmedEvent,
    createToolbarEvent
} from '../analytics/AnalyticsEvents';
import { sendAnalytics } from '../analytics/functions';
import { IStore } from '../app/types';
import {
    rejectParticipantAudio,
    rejectParticipantDesktop,
    rejectParticipantVideo
} from '../av-moderation/actions';
import { MEDIA_TYPE as AVM_MEDIA_TYPE } from '../av-moderation/constants';
import { setAudioMuted, setScreenshareMuted, setVideoMuted } from '../base/media/actions';
import {
    MEDIA_TYPE,
    MediaType,
    SCREENSHARE_MUTISM_AUTHORITY,
    VIDEO_MUTISM_AUTHORITY
} from '../base/media/constants';
import { muteRemoteParticipant } from '../base/participants/actions';
import { getRemoteParticipants, getLocalParticipant, getParticipantById, isLocalParticipantModerator, isParticipantModerator } from '../base/participants/functions';
import { getCurrentConference } from '../base/conference/functions';
import { isParticipantAudioMuted } from '../base/tracks/functions.any';
import { isLocalParticipantApprovedFromState, isParticipantApproved } from '../av-moderation/functions';

import logger from './logger';

/**
 * Mutes the local participant.
 *
 * @param {boolean} enable - Whether to mute or unmute.
 * @param {MEDIA_TYPE} mediaType - The type of the media channel to mute.
 * @returns {Function}
 */
export function muteLocal(enable: boolean, mediaType: MediaType) {
    return (dispatch: IStore['dispatch']) => {
        switch (mediaType) {
        case MEDIA_TYPE.AUDIO: {
            sendAnalytics(createToolbarEvent(AUDIO_MUTE, { enable }));
            dispatch(setAudioMuted(enable, /* ensureTrack */ true));
            break;
        }
        case MEDIA_TYPE.SCREENSHARE: {
            sendAnalytics(createToolbarEvent(DESKTOP_MUTE, { enable }));
            dispatch(setScreenshareMuted(enable, SCREENSHARE_MUTISM_AUTHORITY.USER, /* ensureTrack */ true));
            break;
        }
        case MEDIA_TYPE.VIDEO: {
            sendAnalytics(createToolbarEvent(VIDEO_MUTE, { enable }));
            dispatch(setVideoMuted(enable, VIDEO_MUTISM_AUTHORITY.USER, /* ensureTrack */ true));
            break;
        }
        default: {
            console.error(`Unsupported media type: ${mediaType}`);

            return;
        }
        }
    };
}

/**
 * Mutes the remote participant with the given ID.
 *
 * @param {string} participantId - ID of the participant to mute.
 * @param {MEDIA_TYPE} mediaType - The type of the media channel to mute.
 * @returns {Function}
 */
export function muteRemote(participantId: string, mediaType: MediaType) {
    return (dispatch: IStore['dispatch']) => {
        sendAnalytics(createRemoteMuteConfirmedEvent(participantId, mediaType));

        // TODO(saghul): reconcile these 2 types.
        const muteMediaType = mediaType === MEDIA_TYPE.SCREENSHARE ? 'desktop' : mediaType;

        dispatch(muteRemoteParticipant(participantId, muteMediaType));
    };
}

/**
 * Mutes all participants.
 *
 * @param {Array<string>} exclude - Array of participant IDs to not mute.
 * @param {MEDIA_TYPE} mediaType - The media type to mute.
 * @returns {Function}
 */
export function muteAllParticipants(exclude: Array<string>, mediaType: MediaType) {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();

        getRemoteParticipants(state).forEach((p, id) => {
            if (exclude.includes(id)) {
                return;
            }

            dispatch(muteRemote(id, mediaType));
            if (mediaType === MEDIA_TYPE.AUDIO) {
                dispatch(rejectParticipantAudio(id));
            } else if (mediaType === MEDIA_TYPE.VIDEO) {
                dispatch(rejectParticipantVideo(id));
            } else if (mediaType === MEDIA_TYPE.SCREENSHARE) {
                dispatch(rejectParticipantDesktop(id));
            }
        });
    };
}

/**
 * Mutes all participants including local participant.
 * Uses the same approach as meeting mode to ensure all participants are muted.
 *
 * @param {Array<string>} exclude - Array of participant IDs to not mute.
 * @param {MEDIA_TYPE} mediaType - The media type to mute.
 * @returns {Function}
 */
export function muteAllParticipantsIncludingLocal(exclude: Array<string>, mediaType: MediaType) {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        const localParticipant = getLocalParticipant(state);
        const remoteParticipants = getRemoteParticipants(state);

        const meetingModeEnabled = state['features/meeting-mode']?.enabled || false;
        const audioModerationEnabled = state['features/av-moderation']?.audioModerationEnabled || false;

        console.log('[muteAllParticipantsIncludingLocal] Starting mute all:', {
            mediaType,
            exclude,
            localParticipantId: localParticipant?.id,
            remoteParticipantsCount: remoteParticipants.size,
            excludeList: exclude,
            meetingModeEnabled,
            audioModerationEnabled
        });

        // Mute local participant if not in exclude list
        // Always mute everyone when muteAll is called, but approved participants can unmute themselves later
        if (localParticipant && !exclude.includes(localParticipant.id)) {
            console.log('[muteAllParticipantsIncludingLocal] Force muting local participant (including ADMIN/moderator):', localParticipant.id);
            if (mediaType === MEDIA_TYPE.AUDIO) {
                dispatch(setAudioMuted(true, /* ensureTrack */ true));
            } else if (mediaType === MEDIA_TYPE.VIDEO) {
                dispatch(setVideoMuted(true, VIDEO_MUTISM_AUTHORITY.USER, /* ensureTrack */ true));
            } else if (mediaType === MEDIA_TYPE.SCREENSHARE) {
                dispatch(setScreenshareMuted(true, SCREENSHARE_MUTISM_AUTHORITY.USER, /* ensureTrack */ true));
            }
        }

        // Mute all remote participants (same approach as meeting mode middleware)
        // Use muteRemoteParticipant directly to ensure it works correctly
        // Force mute ALL participants including moderators when exclude is empty
        // BUT only reject AV moderation for participants who haven't been approved
        // Approved participants can still unmute themselves after being muted
        const { conference } = state['features/base/conference'];
        const audioModeration = state['features/av-moderation']?.audioModerationEnabled || false;
        const videoModeration = state['features/av-moderation']?.videoModerationEnabled || false;
        const desktopModeration = state['features/av-moderation']?.desktopModerationEnabled || false;
        
        remoteParticipants.forEach((participant, id) => {
            if (!exclude.includes(id)) {
                // Always mute everyone when muteAll is called
                console.log('[muteAllParticipantsIncludingLocal] Force muting remote participant (including moderator):', id, {
                    isModerator: participant.role === 'moderator',
                    mediaType
                });
                
                // Convert mediaType to string format expected by muteRemoteParticipant
                const muteMediaType = mediaType === MEDIA_TYPE.SCREENSHARE ? 'desktop' : mediaType;
                dispatch(muteRemoteParticipant(id, muteMediaType));
                
                // Only reject AV moderation for participants who haven't been approved
                // Approved participants can still unmute themselves after being muted
                let shouldRejectModeration = true;
                if (meetingModeEnabled && mediaType === MEDIA_TYPE.AUDIO && audioModeration) {
                    const isApproved = isParticipantApproved(id, AVM_MEDIA_TYPE.AUDIO)(state);
                    if (isApproved) {
                        shouldRejectModeration = false;
                        console.log('[muteAllParticipantsIncludingLocal] Skipping AV moderation reject for approved participant (can unmute freely):', id);
                    }
                }
                
                // Force reject participant audio/video/desktop for A/V moderation (only for non-approved participants)
                if (shouldRejectModeration) {
                    if (mediaType === MEDIA_TYPE.AUDIO) {
                        if (audioModeration && conference) {
                            console.log('[muteAllParticipantsIncludingLocal] Force rejecting audio for participant (not approved):', id);
                            conference.avModerationReject(AVM_MEDIA_TYPE.AUDIO, id);
                        } else {
                            dispatch(rejectParticipantAudio(id));
                        }
                    } else if (mediaType === MEDIA_TYPE.VIDEO) {
                        if (videoModeration && conference) {
                            console.log('[muteAllParticipantsIncludingLocal] Force rejecting video for participant (not approved):', id);
                            conference.avModerationReject(AVM_MEDIA_TYPE.VIDEO, id);
                        } else {
                            dispatch(rejectParticipantVideo(id));
                        }
                    } else if (mediaType === MEDIA_TYPE.SCREENSHARE) {
                        if (desktopModeration && conference) {
                            console.log('[muteAllParticipantsIncludingLocal] Force rejecting desktop for participant (not approved):', id);
                            conference.avModerationReject(AVM_MEDIA_TYPE.DESKTOP, id);
                        } else {
                            dispatch(rejectParticipantDesktop(id));
                        }
                    }
                }
            }
        });

        console.log('[muteAllParticipantsIncludingLocal] Finished muting all participants');
    };
}
