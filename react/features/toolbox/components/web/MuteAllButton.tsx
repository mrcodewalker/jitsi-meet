import React from 'react';
import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { translate } from '../../../base/i18n/functions';
import { IconMuteAll } from '../../../base/icons/svg';
import { isLocalParticipantModerator } from '../../../base/participants/functions';
import { MEDIA_TYPE } from '../../../base/media/constants';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { muteAllParticipantsIncludingLocal } from '../../../video-menu/actions.any';
import { showNotification } from '../../../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE, NOTIFICATION_TYPE } from '../../../notifications/constants';
import { requestEnableAudioModeration } from '../../../av-moderation/actions';

/**
 * The type of the React {@code Component} props of {@link MuteAllButton}.
 */
interface IProps extends AbstractButtonProps {
    /**
     * Whether the local participant is moderator or not.
     */
    _isModerator: boolean;

    /**
     * Whether meeting mode is enabled.
     */
    _meetingModeEnabled: boolean;
}

/**
 * Implementation of a button for muting all participants.
 */
class MuteAllButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.muteAll';
    override icon = IconMuteAll;
    override label = 'toolbar.muteAll';
    override tooltip = 'toolbar.muteAll';

    /**
     * Handles clicking / pressing the button, and mutes all participants.
     * Uses the same approach as meeting mode to ensure all participants are muted.
     * Mutes ALL participants including ADMIN and moderators, just like when meeting mode is enabled.
     *
     * @protected
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, _meetingModeEnabled } = this.props;

        sendAnalytics(createToolbarEvent('mute-all'));
        
        // Mute all participants including local participant
        // Uses the same approach as meeting mode: exclude = [] means mute EVERYONE
        // This ensures muteAll works exactly like meeting mode - mute everyone without exceptions
        dispatch(muteAllParticipantsIncludingLocal([], MEDIA_TYPE.AUDIO));
        
        // If meeting mode is enabled, also enable AV moderation when muteAll is pressed
        // This ensures users need approval to unmute after muteAll
        if (_meetingModeEnabled) {
            dispatch(requestEnableAudioModeration());
        }
        
        // Show notification
        dispatch(showNotification({
            titleKey: 'notify.muteAllTitle',
            descriptionKey: 'notify.muteAllDescription',
            appearance: NOTIFICATION_TYPE.NORMAL
        }, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));
    }

    /**
     * Implements React's {@link Component#render()}.
     *
     * @inheritdoc
     * @returns {ReactElement | null}
     */
    override render() {
        // Only show button for moderators
        if (!this.props._isModerator) {
            return null;
        }

        return super.render();
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - The Redux state.
 * @returns {IProps}
 */
function _mapStateToProps(state: any) {
    // Check if local participant is ADMIN (meetingRole) - only ADMIN can see and use this button
    let isAdmin = false;
    try {
        isAdmin = (typeof window !== 'undefined')
            && window?.localStorage?.getItem('meetingRole') === 'ADMIN';
    } catch (e) {
        isAdmin = false;
    }
    
    return {
        _isModerator: isAdmin,
        _meetingModeEnabled: state['features/meeting-mode']?.enabled ?? false
    };
}

export default translate(connect(_mapStateToProps)(MuteAllButton));

