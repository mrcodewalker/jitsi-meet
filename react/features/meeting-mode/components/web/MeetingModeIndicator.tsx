import React from 'react';
import { connect } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import { IconMeeting } from '../../../base/icons/svg';
import Icon from '../../../base/icons/components/Icon';

interface IProps {
    /**
     * Whether the meeting mode is enabled or not.
     */
    _enabled: boolean;
}

const useStyles = makeStyles()(theme => {
    return {
        container: {
            position: 'fixed',
            top: theme.spacing(2),
            left: theme.spacing(2),
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'rgba(41, 98, 255, 0.9)',
            padding: '8px 12px',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 500,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
            transition: 'all 0.3s',

            '&:hover': {
                backgroundColor: 'rgba(41, 98, 255, 1)',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
            }
        },
        icon: {
            marginRight: theme.spacing(1),
            display: 'flex',
            alignItems: 'center'
        }
    };
});

/**
 * Component that displays the meeting mode status.
 *
 * @returns {ReactElement}
 */
function MeetingModeIndicator({ _enabled }: IProps) {
    const { classes } = useStyles();

    console.log('[Meeting Mode] Indicator render:', { 
        enabled: _enabled
    });

    if (!_enabled) {
        return null;
    }

    return (
        <div className={classes.container}>
            <span className={classes.icon}>
                <Icon src={IconMeeting} size={16} />
            </span>
            Đang trong chế độ họp
        </div>
    );
}

/**
 * Maps part of the Redux state to the props of this component.
 *
 * @param {Object} state - The Redux state.
 * @returns {IProps}
 */
function _mapStateToProps(state: IReduxState) {
    return {
        _enabled: state['features/meeting-mode']?.enabled ?? false
    };
}

export default connect(_mapStateToProps)(MeetingModeIndicator);
