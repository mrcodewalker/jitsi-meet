import { Store } from 'redux';

import { IReduxState } from '../app/types';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import StateListenerRegistry from '../base/redux/StateListenerRegistry';
import { TOGGLE_MEETING_MODE } from './actionTypes';

/**
 * The redux middleware for the meeting mode feature.
 * Moved to middleware.ts
 */

/**
 * Listen for changes in the redux state.
 */
StateListenerRegistry.register(
    state => state['features/meeting-mode'],
    (meetingMode, { dispatch, getState }) => {
        if (meetingMode) {
            console.log('Meeting mode state changed:', meetingMode);
        }
    });