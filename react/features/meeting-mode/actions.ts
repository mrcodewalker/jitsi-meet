import { TOGGLE_MEETING_MODE, UPDATE_MEETING_MODE } from './actionTypes';

/**
 * Toggles the meeting mode state.
 *
 * @returns {Object}
 */
export function toggleMeetingMode(enabled?: boolean, timestamp?: number) {
    return {
        type: TOGGLE_MEETING_MODE,
        enabled,
        timestamp: timestamp || Date.now()
    };
}

/**
 * Updates the meeting mode state from remote participant.
 *
 * @returns {Object}
 */
export function updateMeetingMode(enabled: boolean, timestamp: number) {
    return {
        type: UPDATE_MEETING_MODE,
        enabled,
        timestamp
    };
}