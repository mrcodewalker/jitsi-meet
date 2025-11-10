import { AnyAction } from 'redux';
import { TOGGLE_MEETING_MODE, UPDATE_MEETING_MODE, SET_CURRENT_SPEAKER } from './actionTypes';

/**
 * The initial state.
 */
const INITIAL_STATE = {
    enabled: false,
    timestamp: 0,
    currentSpeaker: null,
    lastUnmuteTime: 0 // Track last unmute time to prevent spam
};

/**
 * Reduces redux actions for the purposes of the feature meeting-mode.
 */
const meetingMode = (state = INITIAL_STATE, action: AnyAction) => {
    switch (action.type) {
        case TOGGLE_MEETING_MODE:
            const newEnabled = action.enabled !== undefined ? action.enabled : !state.enabled;
            return {
                ...state,
                enabled: newEnabled,
                timestamp: newEnabled ? action.timestamp || Date.now() : 0,
                currentSpeaker: newEnabled ? null : state.currentSpeaker
            };

        case UPDATE_MEETING_MODE:
            return {
                ...state,
                enabled: action.enabled,
                timestamp: action.timestamp,
                currentSpeaker: action.enabled ? null : state.currentSpeaker
            };

        case SET_CURRENT_SPEAKER:
            return {
                ...state,
                currentSpeaker: action.speakerId,
                // Update last unmute time when speaker changes
                // If speaker is cleared (null), reset lastUnmuteTime to 0 to allow others to unmute immediately
                lastUnmuteTime: action.speakerId ? Date.now() : 0
            };

        default:
            return state;
    }
};

export default meetingMode;