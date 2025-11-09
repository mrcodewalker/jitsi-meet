import React from 'react';
import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { IconMeeting, IconMeetingOff } from '../../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { isLocalParticipantModerator } from '../../../base/participants/functions';
import { showWarningNotification } from '../../../notifications/actions';
import { toggleMeetingMode } from '../../../meeting-mode/actions';

/**
 * The type of the React {@code Component} props of {@link MeetingModeButton}.
 */
interface IProps extends AbstractButtonProps {
    /**
     * Whether the meeting mode is enabled or not.
     */
    _enabled: boolean;

    /**
     * Whether the local participant is moderator or not.
     */
    _isModerator: boolean;
}

/**
 * An implementation of a button to toggle meeting mode.
 */
class MeetingModeButton extends AbstractButton<IProps> {
    accessibilityLabel = 'Chế độ họp';

    /**
     * Handles clicking / pressing the button.
     *
     * @protected
     * @returns {void}
     */
    _handleClick() {
        sendAnalytics(createToolbarEvent('meeting.mode.toggled', {
            enabled: !this.props._enabled
        }));

        this.props.dispatch(toggleMeetingMode());
    }

    /**
     * Implements React's {@link Component#render()}.
     *
     * @inheritdoc
     * @returns {ReactElement | null}
     */
    render() {
        // Only show button for moderators
        if (!this.props._isModerator) {
            return null;
        }

        return super.render();
    }

    /**
     * Gets the current icon based on the meeting mode state.
     *
     * @returns {Object}
     */
    _getIcon() {
        return this.props._enabled ? IconMeeting : IconMeetingOff;
    }

    /**
     * Gets the label to be displayed.
     *
     * @returns {string}
     */
    _getLabel() {
        return this.props._enabled ? 'Tắt chế độ họp' : 'Bật chế độ họp';
    }

    /**
     * Gets the tooltip to be displayed.
     *
     * @returns {string}
     */
    _getTooltip() {
        return this.props._enabled ? 'Tắt chế độ họp' : 'Bật chế độ họp';
    }

    /**
     * Indicates whether this button is in toggled state or not.
     *
     * @protected
     * @returns {boolean}
     */
    _isToggled() {
        return this.props._enabled;
    }
}

/**
 * Maps part of the Redux state to the props of this component.
 *
 * @param {Object} state - The Redux state.
 * @returns {IProps}
 */
function _mapStateToProps(state: IReduxState) {
    return {
        _enabled: state['features/meeting-mode']?.enabled ?? false,
        _isModerator: isLocalParticipantModerator(state)
    };
}

export default connect(_mapStateToProps)(MeetingModeButton);