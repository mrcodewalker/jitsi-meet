/* eslint-disable react/jsx-no-bind */
import React, { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { connect, useDispatch } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import Avatar from '../../../base/avatar/components/Avatar';
import { isNameReadOnly } from '../../../base/config/functions.web';
import { IconArrowDown, IconArrowUp, IconPhoneRinging, IconVolumeOff } from '../../../base/icons/svg';
import { isVideoMutedByUser } from '../../../base/media/functions';
import { getLocalParticipant } from '../../../base/participants/functions';
import Popover from '../../../base/popover/components/Popover.web';
import ActionButton from '../../../base/premeeting/components/web/ActionButton';
import PreMeetingScreen from '../../../base/premeeting/components/web/PreMeetingScreen';
import { updateSettings } from '../../../base/settings/actions';
import { getDisplayName } from '../../../base/settings/functions.web';
import { getLocalJitsiVideoTrack } from '../../../base/tracks/functions.web';
import Button from '../../../base/ui/components/web/Button';
import Input from '../../../base/ui/components/web/Input';
import { BUTTON_TYPES } from '../../../base/ui/constants.any';
import isInsecureRoomName from '../../../base/util/isInsecureRoomName';
import { openDisplayNamePrompt } from '../../../display-name/actions';
import { isUnsafeRoomWarningEnabled } from '../../functions.any';
import {
    joinConference as joinConferenceAction,
    joinConferenceWithoutAudio as joinConferenceWithoutAudioAction,
    setJoinByPhoneDialogVisiblity as setJoinByPhoneDialogVisiblityAction
} from '../../actions.web';
import {
    isDeviceStatusVisible,
    isDisplayNameRequired,
    isJoinByPhoneButtonVisible,
    isJoinByPhoneDialogVisible,
    isPrejoinDisplayNameVisible
} from '../../functions.any';
import logger from '../../logger';
import { hasDisplayName } from '../../utils';

import JoinByPhoneDialog from './dialogs/JoinByPhoneDialog';

interface IProps {

    /**
     * Flag signaling if the device status is visible or not.
     */
    deviceStatusVisible: boolean;

    /**
     * If join by phone button should be visible.
     */
    hasJoinByPhoneButton: boolean;

    /**
     * Flag signaling if the display name is visible or not.
     */
    isDisplayNameVisible: boolean;

    /**
     * Joins the current meeting.
     */
    joinConference: Function;

    /**
     * Joins the current meeting without audio.
     */
    joinConferenceWithoutAudio: Function;

    /**
     * Whether conference join is in progress.
     */
    joiningInProgress?: boolean;

    /**
     * The name of the user that is about to join.
     */
    name: string;

    /**
     * Local participant id.
     */
    participantId?: string;

    /**
     * The prejoin config.
     */
    prejoinConfig?: any;

    /**
     * Whether the name input should be read only or not.
     */
    readOnlyName: boolean;

    /**
     * Sets visibility of the 'JoinByPhoneDialog'.
     */
    setJoinByPhoneDialogVisiblity: Function;

    /**
     * Flag signaling the visibility of camera preview.
     */
    showCameraPreview: boolean;

    /**
     * If 'JoinByPhoneDialog' is visible or not.
     */
    showDialog: boolean;

    /**
     * If should show an error when joining without a name.
     */
    showErrorOnJoin: boolean;

    /**
     * If the recording warning is visible or not.
     */
    showRecordingWarning: boolean;

    /**
     * If should show unsafe room warning when joining.
     */
    showUnsafeRoomWarning: boolean;

    /**
     * Whether the user has approved to join a room with unsafe name.
     */
    unsafeRoomConsent?: boolean;

    /**
     * Updates settings.
     */
    updateSettings: Function;

    /**
     * The JitsiLocalTrack to display.
     */
    videoTrack?: Object;
}

const useStyles = makeStyles()(theme => {
    return {
        inputContainer: {
            width: '100%'
        },

        input: {
            width: '100%',
            marginBottom: theme.spacing(3),

            '& input': {
                textAlign: 'center'
            }
        },

        avatarContainer: {
            display: 'flex',
            alignItems: 'center',
            flexDirection: 'column'
        },

        avatar: {
            margin: `${theme.spacing(2)} auto ${theme.spacing(3)}`
        },

        avatarName: {
            ...theme.typography.bodyShortBoldLarge,
            color: theme.palette.text01,
            marginBottom: theme.spacing(5),
            textAlign: 'center'
        },

        error: {
            backgroundColor: theme.palette.actionDanger,
            color: theme.palette.text01,
            borderRadius: theme.shape.borderRadius,
            width: '100%',
            ...theme.typography.labelRegular,
            boxSizing: 'border-box',
            padding: theme.spacing(1),
            textAlign: 'center',
            marginTop: `-${theme.spacing(2)}`,
            marginBottom: theme.spacing(3)
        },

        dropdownContainer: {
            position: 'relative',
            width: '100%'
        },

        dropdownButtons: {
            width: '300px',
            padding: '8px 0',
            backgroundColor: theme.palette.action02,
            color: theme.palette.text04,
            borderRadius: theme.shape.borderRadius,
            position: 'relative',
            top: `-${theme.spacing(3)}`,

            '@media (max-width: 511px)': {
                margin: '0 auto',
                top: 0
            },

            '@media (max-width: 420px)': {
                top: 0,
                width: 'calc(100% - 32px)'
            }
        }
    };
});

const Prejoin = ({
    deviceStatusVisible,
    hasJoinByPhoneButton,
    isDisplayNameVisible,
    joinConference,
    joinConferenceWithoutAudio,
    joiningInProgress,
    name,
    participantId,
    prejoinConfig,
    readOnlyName,
    setJoinByPhoneDialogVisiblity,
    showCameraPreview,
    showDialog,
    showErrorOnJoin,
    showRecordingWarning,
    showUnsafeRoomWarning,
    unsafeRoomConsent,
    updateSettings: dispatchUpdateSettings,
    videoTrack
}: IProps) => {
    const showDisplayNameField = useMemo(
        () => isDisplayNameVisible && !readOnlyName,
        [ isDisplayNameVisible, readOnlyName ]);
    const showErrorOnField = useMemo(
        () => showDisplayNameField && showErrorOnJoin,
        [ showDisplayNameField, showErrorOnJoin ]);
    const [ showJoinByPhoneButtons, setShowJoinByPhoneButtons ] = useState(false);
    const [ isCheckingAccess, setIsCheckingAccess ] = useState(false);
    const [ accessChecked, setAccessChecked ] = useState(false);
    const [ showInvalidAccessMessage, setShowInvalidAccessMessage ] = useState(false);
    const [ meetingData, setMeetingData ] = useState<any>(null);
    const [ attendanceLogId, setAttendanceLogId ] = useState<number | null>(null);
    const { classes } = useStyles();
    const { t } = useTranslation();
    const dispatch = useDispatch();

    /**
     * Get URL parameters
     */
    const getUrlParams = () => {
        const urlParams = new URLSearchParams(window.location.search);
        // Derive meetLink from pathname as fallback: e.g. https://host/<meetLink>
        const pathPart = (window.location.pathname || '/').replace(/^\//, '').split('/')[0] || null;
        const meetLinkParam = urlParams.get('meetLink');
        const tokenParam = urlParams.get('token');

        console.log('getUrlParams - URL search:', window.location.search);
        console.log('getUrlParams - Parsed params:', { meetLinkParam, tokenParam, pathPart });

        return {
            meetLink: meetLinkParam || pathPart,
            token: tokenParam
        } as { meetLink: string | null; token: string | null };
    };

    /**
     * Check meeting access
     */
    const checkMeetingAccess = async (meetLink: string, token: string) => {
        try {
            setIsCheckingAccess(true);
            const response = await fetch('https://signal.kolla.click/api/v1/members/check-meeting-access', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    token,
                    meetLink
                })
            });

            const result = await response.json();
            return result;
        } catch (error) {
            console.error('Error checking meeting access:', error);
            return { success: false, networkError: true } as any;
        } finally {
            setIsCheckingAccess(false);
        }
    };

    /**
     * Create attendance log
     */
    const createAttendanceLog = async (meetLink: string, token: string, action: 'join' | 'leave') => {
        try {
            console.log('Creating attendance log for:', { meetLink, token, action });
            const response = await fetch('https://signal.kolla.click/api/v1/attendance-logs/create-with-token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    token,
                    meetLink,
                    action
                })
            });

            const result = await response.json();
            console.log('Attendance log created:', result);
            
            // Save attendance log ID if successful
            if (result.success && result.data?.id) {
                setAttendanceLogId(result.data.id);
                localStorage.setItem('attendanceLogId', result.data.id.toString());
            }
            
            return result;
        } catch (error) {
            console.error('Error creating attendance log:', error);
            return { success: false, error: error.message };
        }
    };

    /**
     * Leave attendance log
     */
    const leaveAttendanceLog = async (id: number, token: string) => {
        try {
            console.log('Leaving attendance log for:', { id, token });
            const response = await fetch(`https://signal.kolla.click/api/v1/attendance-logs/${id}/leave-with-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    token
                })
            });

            const result = await response.json();
            console.log('Attendance log leave updated:', result);
            return result;
        } catch (error) {
            console.error('Error leaving attendance log:', error);
            return { success: false, error: error.message };
        }
    };

    /**
     * Remove token and meetLink from URL and set localStorage
     */
    const removeTokenFromUrl = (meetLink: string, token: string) => {
        // Set localStorage for future use
        localStorage.setItem('meetLink', meetLink);
        localStorage.setItem('token', token);
        
        // Clean up URL by removing query parameters
        const url = new URL(window.location.href);
        url.search = ''; // Remove all query parameters
        window.history.replaceState({}, '', url.toString());
    };

    /**
     * Navigate to external URL with delay
     */
    const navigateToExternal = () => {
        setShowInvalidAccessMessage(true);
        setTimeout(() => {
            window.location.href = 'https://meeting.kolla.click/';
        }, 10000); // 10 seconds delay
    };

    /**
     * Check access on component mount - ALWAYS refresh on mount/F5 to get latest meeting info
     * When F5 is pressed, this will always fetch fresh data from server to update meetingRole and meetingResponse
     */
    useEffect(() => {
        // Reset access checked state to ensure we always make a fresh request on F5
        setAccessChecked(false);
        setMeetingData(null);

        const { meetLink, token } = getUrlParams();
        let effectiveMeetLink = meetLink;
        let effectiveToken = token;
        // Consider "fromUrl" true if at least one credential came from URL, so we can clean it up
        const fromUrl = Boolean(meetLink || token);

        // Debug URL parameters
        console.log('URL Parameters:', { meetLink, token });
        console.log('Current URL:', window.location.href);
        console.log('Search params:', window.location.search);

        // CRITICAL: Save meetLink and token to localStorage IMMEDIATELY if they come from URL
        // This ensures they are saved even if API call fails or is delayed
        if (meetLink || token) {
            try {
                if (meetLink) {
                    localStorage.setItem('meetLink', meetLink);
                    console.log('✅ Saved meetLink to localStorage immediately:', meetLink);
                }
                if (token) {
                    localStorage.setItem('token', token);
                    console.log('✅ Saved token to localStorage immediately');
                }
            } catch (e) {
                console.warn('Unable to save credentials to localStorage:', e);
            }
        }

        // When F5 (refresh), prioritize localStorage to get meetLink and token
        // This ensures we always have credentials even if URL params are cleared
        if (!effectiveMeetLink || !effectiveToken) {
            const storedMeetLink = localStorage.getItem('meetLink');
            const storedToken = localStorage.getItem('token');

            console.log('Loading from localStorage on refresh:', { storedMeetLink: !!storedMeetLink, storedToken: !!storedToken });

            // Prefer explicitly provided values over storage, but use storage if URL params missing
            effectiveMeetLink = effectiveMeetLink || storedMeetLink;
            effectiveToken = effectiveToken || storedToken;

            // CRITICAL: Ensure token is saved to localStorage if we have it (from URL or storage)
            if (effectiveToken) {
                try {
                    localStorage.setItem('token', effectiveToken);
                    console.log('✅ Ensured token is saved to localStorage');
                } catch (e) {
                    console.warn('Unable to save token to localStorage:', e);
                }
            }

            // CRITICAL: Ensure meetLink is saved to localStorage if we have it
            if (effectiveMeetLink) {
                try {
                    localStorage.setItem('meetLink', effectiveMeetLink);
                    console.log('✅ Ensured meetLink is saved to localStorage');
                } catch (e) {
                    console.warn('Unable to save meetLink to localStorage:', e);
                }
            }

            if (!effectiveMeetLink && !effectiveToken) {
                console.log('Missing parameters - meetLink and token are both absent.');
                navigateToExternal();
                return;
            }
        }

        const verifyAccess = async () => {
            // ALWAYS make a fresh request to get latest meeting information on F5
            // This ensures meetingRole and other meeting data are up-to-date even if user is already in room
            console.log('Making fresh access check request to get latest meeting info (F5 refresh)...');
            console.log('Using credentials:', { meetLink: effectiveMeetLink, hasToken: !!effectiveToken });
            
            // Try up to 3 times on transient errors to avoid kicking the user out on refresh
            let attempts = 0;
            let result: any = null;
            do {
                attempts++;
                result = await checkMeetingAccess(effectiveMeetLink as string, effectiveToken as string);
                console.log(`Access check attempt ${attempts}:`, result);
                if (result?.success || (result?.data && result?.data?.hasAccess === false)) {
                    break;
                }
                if (result?.networkError) {
                    await new Promise(res => setTimeout(res, 800));
                }
            } while (attempts < 3);

            // Debug logging
            console.log('Final API Response:', result);
            console.log('MeetLink:', effectiveMeetLink);
            console.log('Token:', effectiveToken);

            if (result?.success && result?.data?.hasAccess === true) {
                console.log('Access granted, updating meeting data with latest info from server:', result.data);

                // ALWAYS update meeting data with latest information from server
                // This is critical on F5 to get updated meetingRole
                setMeetingData(result.data);

                // Set display name from user data if available (always update)
                if (result.data?.user?.name) {
                    console.log('Updating display name:', result.data.user.name);
                    dispatchUpdateSettings({
                        displayName: result.data.user.name
                    });
                }

                // ALWAYS save full response to localStorage - this updates meetingResponse on F5
                try {
                    localStorage.setItem('meetingResponse', JSON.stringify(result.data));
                    console.log('✅ Updated meetingResponse in localStorage with latest data from server');
                } catch (e) {
                    console.warn('Unable to persist meetingResponse to localStorage');
                }

                // ALWAYS update meetingRole in localStorage with latest meetingRole from server
                // This ensures meetingRole changes are reflected immediately on F5 refresh
                if (result.data?.meeting?.meetingRole) {
                    try {
                        const latestMeetingRole = String(result.data.meeting.meetingRole);
                        const oldMeetingRole = localStorage.getItem('meetingRole');
                        localStorage.setItem('meetingRole', latestMeetingRole);
                        console.log('✅ Updated meetingRole in localStorage:', {
                            old: oldMeetingRole,
                            new: latestMeetingRole
                        });
                        console.log('Meeting data:', {
                            meetingRole: result.data.meeting.meetingRole,
                            meetingId: result.data.meeting?.id,
                            meetingCode: result.data.meeting?.meetingCode
                        });
                    } catch (e) {
                        console.warn('Unable to persist meetingRole to localStorage');
                    }
                } else {
                    // Clear meetingRole if not present in response
                    try {
                        localStorage.removeItem('meetingRole');
                        console.log('Cleared meetingRole from localStorage (not in response)');
                    } catch (e) {
                        console.warn('Unable to clear meetingRole from localStorage');
                    }
                }

                setAccessChecked(true);
                // Always persist latest values for refresh resilience
                if (effectiveMeetLink) {
                    localStorage.setItem('meetLink', effectiveMeetLink as string);
                }
                if (effectiveToken) {
                    localStorage.setItem('token', effectiveToken as string);
                }
                // Clean up URL if anything came from URL
                if (fromUrl && effectiveMeetLink && effectiveToken) {
                    removeTokenFromUrl(effectiveMeetLink as string, effectiveToken as string);
                }
            } else if (result?.success && result?.data?.hasAccess === false) {
                console.log('Access explicitly denied, navigating to external URL');
                navigateToExternal();
            } else {
                // Transient failure or unknown error: do NOT redirect if we have stored creds
                console.warn('Access check failed due to network or unknown error, keeping user on page');
                setAccessChecked(true);
                // Ensure creds remain in storage
                if (effectiveMeetLink) {
                    localStorage.setItem('meetLink', effectiveMeetLink as string);
                }
                if (effectiveToken) {
                    localStorage.setItem('token', effectiveToken as string);
                }
            }
        };

        // If we have both meetLink and token (from URL or localStorage), always verify access
        // This ensures F5 always triggers a fresh request to update meetingRole and meetingResponse
        if (effectiveMeetLink && effectiveToken) {
            // Always call verifyAccess to get latest meeting information on F5
            setTimeout(() => {
                verifyAccess();
            }, 100);
        } else if (effectiveMeetLink && !effectiveToken) {
            // If we have meetLink but no token yet, persist meetLink and wait
            try {
                localStorage.setItem('meetLink', effectiveMeetLink);
                console.log('✅ Saved meetLink to localStorage (waiting for token)');
            } catch (e) {
                console.warn('Unable to save meetLink to localStorage:', e);
            }
            setAccessChecked(true);
        } else {
            // No credentials at all
            console.log('No credentials available, redirecting...');
            navigateToExternal();
        }
    }, []);


    /**
     * Load attendance log ID from localStorage on component mount
     */
    useEffect(() => {
        const storedAttendanceLogId = localStorage.getItem('attendanceLogId');
        if (storedAttendanceLogId) {
            setAttendanceLogId(parseInt(storedAttendanceLogId, 10));
        }
    }, []);

    /**
     * Handle page unload to update leave attendance log
     */
    useEffect(() => {
        const handleBeforeUnload = async () => {
            const storedAttendanceLogId = localStorage.getItem('attendanceLogId');
            const token = localStorage.getItem('token');
            
            if (storedAttendanceLogId && token) {
                // Use sendBeacon for reliable delivery during page unload
                const data = JSON.stringify({ token });
                
                if (navigator.sendBeacon) {
                    navigator.sendBeacon(
                        `https://signal.kolla.click/api/v1/attendance-logs/${storedAttendanceLogId}/leave-with-token`,
                        data
                    );
                } else {
                    // Fallback for browsers that don't support sendBeacon
                    await leaveAttendanceLog(parseInt(storedAttendanceLogId, 10), token);
                }
            }
        };

        // Add event listener for page unload
        window.addEventListener('beforeunload', handleBeforeUnload);

        // Cleanup function
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, []);

    /**
     * Handler for the join button.
     *
     * @param {Object} e - The synthetic event.
     * @returns {void}
     */
    const onJoinButtonClick = async () => {
        if (showErrorOnJoin) {
            dispatch(openDisplayNamePrompt({
                onPostSubmit: joinConference,
                validateInput: hasDisplayName
            }));

            return;
        }

        console.log('Prejoin join button clicked.');

        // Create attendance log before joining
        const meetLink = localStorage.getItem('meetLink');
        const token = localStorage.getItem('token');
        
        if (meetLink && token) {
            await createAttendanceLog(meetLink, token, 'join');
        }

        joinConference();
    };

    /**
     * Closes the dropdown.
     *
     * @returns {void}
     */
    const onDropdownClose = () => {
        setShowJoinByPhoneButtons(false);
    };

    /**
     * Displays the join by phone buttons dropdown.
     *
     * @param {Object} e - The synthetic event.
     * @returns {void}
     */
    const onOptionsClick = (e?: React.KeyboardEvent | React.MouseEvent | undefined) => {
        e?.stopPropagation();

        setShowJoinByPhoneButtons(show => !show);
    };

    /**
     * Sets the guest participant name.
     *
     * @param {string} displayName - Participant name.
     * @returns {void}
     */
    const setName = (displayName: string) => {
        dispatchUpdateSettings({
            displayName
        });
    };

    /**
     * Closes the join by phone dialog.
     *
     * @returns {undefined}
     */
    const closeDialog = () => {
        setJoinByPhoneDialogVisiblity(false);
    };

    /**
     * Displays the dialog for joining a meeting by phone.
     *
     * @returns {undefined}
     */
    const doShowDialog = () => {
        setJoinByPhoneDialogVisiblity(true);
        onDropdownClose();
    };

    /**
     * KeyPress handler for accessibility.
     *
     * @param {Object} e - The key event to handle.
     *
     * @returns {void}
     */
    const showDialogKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            doShowDialog();
        }
    };

    /**
     * KeyPress handler for accessibility.
     *
     * @param {Object} e - The key event to handle.
     *
     * @returns {void}
     */
    const onJoinConferenceWithoutAudioKeyPress = async (e: React.KeyboardEvent) => {
        if (joinConferenceWithoutAudio
            && (e.key === ' '
                || e.key === 'Enter')) {
            e.preventDefault();
            console.log('Prejoin joinConferenceWithoutAudio dispatched on a key pressed.');
            
            // Create attendance log before joining without audio
            const meetLink = localStorage.getItem('meetLink');
            const token = localStorage.getItem('token');
            
            if (meetLink && token) {
                await createAttendanceLog(meetLink, token, 'join');
            }
            
            joinConferenceWithoutAudio();
        }
    };

    /**
     * Gets the list of extra join buttons.
     *
     * @returns {Object} - The list of extra buttons.
     */
    const getExtraJoinButtons = () => {
        const noAudio = {
            key: 'no-audio',
            testId: 'prejoin.joinWithoutAudio',
            icon: IconVolumeOff,
            label: t('prejoin.joinWithoutAudio'),
            onClick: async () => {
                console.log('Prejoin join conference without audio pressed.');
                
                // Create attendance log before joining without audio
                const meetLink = localStorage.getItem('meetLink');
                const token = localStorage.getItem('token');
                
                if (meetLink && token) {
                    await createAttendanceLog(meetLink, token, 'join');
                }
                
                joinConferenceWithoutAudio();
            },
            onKeyPress: onJoinConferenceWithoutAudioKeyPress
        };

        const byPhone = {
            key: 'by-phone',
            testId: 'prejoin.joinByPhone',
            icon: IconPhoneRinging,
            label: t('prejoin.joinAudioByPhone'),
            onClick: doShowDialog,
            onKeyPress: showDialogKeyPress
        };

        return {
            noAudio,
            byPhone
        };
    };

    /**
     * Handle keypress on input.
     *
     * @param {KeyboardEvent} e - Keyboard event.
     * @returns {void}
     */
    const onInputKeyPress = async (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            console.log('Dispatching join conference on Enter key press from the prejoin screen.');
            
            // Create attendance log before joining
            const meetLink = localStorage.getItem('meetLink');
            const token = localStorage.getItem('token');
            
            if (meetLink && token) {
                await createAttendanceLog(meetLink, token, 'join');
            }
            
            joinConference();
        }
    };

    const extraJoinButtons = getExtraJoinButtons();
    let extraButtonsToRender = Object.values(extraJoinButtons).filter((val: any) =>
        !(prejoinConfig?.hideExtraJoinButtons || []).includes(val.key)
    );

    if (!hasJoinByPhoneButton) {
        extraButtonsToRender = extraButtonsToRender.filter((btn: any) => btn.key !== 'by-phone');
    }
    const hasExtraJoinButtons = Boolean(extraButtonsToRender.length);

    // Show invalid access message
    if (showInvalidAccessMessage) {
        return (
            <PreMeetingScreen
                showDeviceStatus = { false }
                showRecordingWarning = { false }
                showUnsafeRoomWarning = { false }
                title = { t('prejoin.joinMeeting') }
                videoMuted = { !showCameraPreview }
                videoTrack = { videoTrack }>
                <div
                    className = { classes.inputContainer }
                    data-testid = 'prejoin.screen'>
                    <div className="access-error-container">
                        <div className="access-error-title">
                            ⚠️ Thông tin không hợp lệ
                        </div>
                        <p className="access-error-message">
                            Bạn không có quyền truy cập vào cuộc họp này.
                        </p>
                        <p className="access-error-submessage">
                            Bạn sẽ được chuyển hướng về trang chủ trong 10 giây...
                        </p>
                        <div className="countdown-bar">
                            <div className="countdown-progress"></div>
                        </div>
                    </div>
                </div>
            </PreMeetingScreen>
        );
    }

    // Show loading state while checking access
    if (isCheckingAccess || !accessChecked) {
        return (
            <PreMeetingScreen
                showDeviceStatus = { false }
                showRecordingWarning = { false }
                showUnsafeRoomWarning = { false }
                title = { meetingData?.meeting?.title || t('prejoin.joinMeeting') }
                videoMuted = { !showCameraPreview }
                videoTrack = { videoTrack }>
                <div
                    className = { classes.inputContainer }
                    data-testid = 'prejoin.screen'>
                    <div style={{ textAlign: 'center', padding: '20px' }}>
                        <p>{t('prejoin.checkingAccess', 'Đang kiểm tra quyền truy cập...')}</p>
                    </div>
                </div>
            </PreMeetingScreen>
        );
    }

    return (
        <PreMeetingScreen
            showDeviceStatus = { deviceStatusVisible }
            showRecordingWarning = { showRecordingWarning }
            showUnsafeRoomWarning = { showUnsafeRoomWarning }
            title = { meetingData?.meeting?.title || t('prejoin.joinMeeting') }
            videoMuted = { !showCameraPreview }
            videoTrack = { videoTrack }>
            <div
                className = { classes.inputContainer }
                data-testid = 'prejoin.screen'>
                {showDisplayNameField ? (<Input
                    accessibilityLabel = { t('dialog.enterDisplayName') }
                    autoComplete = { 'name' }
                    autoFocus = { true }
                    className = { classes.input }
                    error = { showErrorOnField }
                    id = 'premeeting-name-input'
                    onChange = { setName }
                    onKeyPress = { showUnsafeRoomWarning && !unsafeRoomConsent ? undefined : onInputKeyPress }
                    placeholder = { t('dialog.enterDisplayName') }
                    readOnly = { readOnlyName }
                    value = { name } />
                ) : (
                    <div className = { classes.avatarContainer }>
                        <Avatar
                            className = { classes.avatar }
                            displayName = { name }
                            participantId = { participantId }
                            size = { 72 } />
                        {isDisplayNameVisible && <div className = { classes.avatarName }>{name}</div>}
                    </div>
                )}

                {showErrorOnField && <div
                    className = { classes.error }
                    data-testid = 'prejoin.errorMessage'>
                    <p aria-live = 'polite' >
                        {t('prejoin.errorMissingName')}
                    </p>
                </div>}

                <div className = { classes.dropdownContainer }>
                    <Popover
                        content = { hasExtraJoinButtons && <div className = { classes.dropdownButtons }>
                            {extraButtonsToRender.map(({ key, ...rest }) => (
                                <Button
                                    disabled = { joiningInProgress || showErrorOnField }
                                    fullWidth = { true }
                                    key = { key }
                                    type = { BUTTON_TYPES.SECONDARY }
                                    { ...rest } />
                            ))}
                        </div> }
                        onPopoverClose = { onDropdownClose }
                        position = 'bottom'
                        trigger = 'click'
                        visible = { showJoinByPhoneButtons }>
                        <ActionButton
                            OptionsIcon = { showJoinByPhoneButtons ? IconArrowUp : IconArrowDown }
                            ariaDropDownLabel = { t('prejoin.joinWithoutAudio') }
                            ariaLabel = { t('prejoin.joinMeeting') }
                            ariaPressed = { showJoinByPhoneButtons }
                            disabled = { joiningInProgress
                                || (showUnsafeRoomWarning && !unsafeRoomConsent)
                                || showErrorOnField }
                            hasOptions = { hasExtraJoinButtons }
                            onClick = { onJoinButtonClick }
                            onOptionsClick = { onOptionsClick }
                            role = 'button'
                            tabIndex = { 0 }
                            testId = 'prejoin.joinMeeting'
                            type = 'primary'>
                            {t('prejoin.joinMeeting')}
                        </ActionButton>
                    </Popover>
                </div>
            </div>
            {showDialog && (
                <JoinByPhoneDialog
                    joinConferenceWithoutAudio = { joinConferenceWithoutAudio }
                    onClose = { closeDialog } />
            )}
        </PreMeetingScreen>
    );
};


/**
 * Maps (parts of) the redux state to the React {@code Component} props.
 *
 * @param {Object} state - The redux state.
 * @returns {Object}
 */
function mapStateToProps(state: IReduxState) {
    const name = getDisplayName(state);
    const showErrorOnJoin = isDisplayNameRequired(state) && !name;
    const { id: participantId } = getLocalParticipant(state) ?? {};
    const { joiningInProgress } = state['features/prejoin'];
    const { room } = state['features/base/conference'];
    const { unsafeRoomConsent } = state['features/base/premeeting'];
    const { showPrejoinWarning: showRecordingWarning } = state['features/base/config'].recordings ?? {};

    return {
        deviceStatusVisible: isDeviceStatusVisible(state),
        hasJoinByPhoneButton: isJoinByPhoneButtonVisible(state),
        isDisplayNameVisible: isPrejoinDisplayNameVisible(state),
        joiningInProgress,
        name,
        participantId,
        prejoinConfig: state['features/base/config'].prejoinConfig,
        readOnlyName: isNameReadOnly(state),
        showCameraPreview: !isVideoMutedByUser(state),
        showDialog: isJoinByPhoneDialogVisible(state),
        showErrorOnJoin,
        showRecordingWarning: Boolean(showRecordingWarning),
        showUnsafeRoomWarning: isInsecureRoomName(room) && isUnsafeRoomWarningEnabled(state),
        unsafeRoomConsent,
        videoTrack: getLocalJitsiVideoTrack(state)
    };
}

const mapDispatchToProps = {
    joinConferenceWithoutAudio: joinConferenceWithoutAudioAction,
    joinConference: joinConferenceAction,
    setJoinByPhoneDialogVisiblity: setJoinByPhoneDialogVisiblityAction,
    updateSettings
};

export default connect(mapStateToProps, mapDispatchToProps)(Prejoin);
