import { Theme } from '@mui/material';
import React, { Component, RefObject } from 'react';
import { WithTranslation } from 'react-i18next';
import { connect } from 'react-redux';
import { withStyles } from 'tss-react/mui';

import { IReduxState, IStore } from '../../../app/types';
import { isMobileBrowser } from '../../../base/environment/utils';
import { translate } from '../../../base/i18n/functions';
import { IconFaceSmile, IconSend } from '../../../base/icons/svg';
import Button from '../../../base/ui/components/web/Button';
import Input from '../../../base/ui/components/web/Input';
import { CHAT_SIZE } from '../../constants';
import { areSmileysDisabled, isSendGroupChatDisabled } from '../../functions';

import SmileysPanel from './SmileysPanel';


const styles = (_theme: Theme, { _chatWidth }: IProps) => {
    return {
        smileysPanel: {
            bottom: '100%',
            boxSizing: 'border-box' as const,
            backgroundColor: 'rgba(0, 0, 0, .6) !important',
            height: 'auto',
            display: 'flex' as const,
            overflow: 'hidden',
            position: 'absolute' as const,
            width: `${_chatWidth - 32}px`,
            marginBottom: '5px',
            marginLeft: '-5px',
            transition: 'max-height 0.3s',

            '& #smileysContainer': {
                backgroundColor: '#131519',
                borderTop: '1px solid #A4B8D1'
            }
        },
        chatDisabled: {
            borderTop: `1px solid ${_theme.palette.ui02}`,
            boxSizing: 'border-box' as const,
            padding: _theme.spacing(4),
            textAlign: 'center' as const,
        }
    };
};

/**
 * The type of the React {@code Component} props of {@link ChatInput}.
 */
interface IProps extends WithTranslation {

    /**
     * Whether chat emoticons are disabled.
     */
    _areSmileysDisabled: boolean;


    _chatWidth: number;

    /**
     * Whether sending group chat messages is disabled.
     */
    _isSendGroupChatDisabled: boolean;

    /**
     * The id of the message recipient, if any.
     */
    _privateMessageRecipientId?: string;

    /**
     * An object containing the CSS classes.
     */
    classes?: Partial<Record<keyof ReturnType<typeof styles>, string>>;

    /**
     * Invoked to send chat messages.
     */
    dispatch: IStore['dispatch'];

    /**
     * Callback to invoke on message send.
     */
    onSend: Function;
}

/**
 * The type of the React {@code Component} state of {@link ChatInput}.
 */
interface IState {

    /**
     * User provided nickname when the input text is provided in the view.
     */
    message: string;

    /**
     * Whether or not the smiley selector is visible.
     */
    showSmileysPanel: boolean;
}

/**
 * Implements a React Component for drafting and submitting a chat message.
 *
 * @augments Component
 */
class ChatInput extends Component<IProps, IState> {
    _textArea?: RefObject<HTMLTextAreaElement>;

    override state = {
        message: '',
        showSmileysPanel: false
    };

    /**
     * Initializes a new {@code ChatInput} instance.
     *
     * @param {Object} props - The read-only properties with which the new
     * instance is to be initialized.
     */
    constructor(props: IProps) {
        super(props);

        this._textArea = React.createRef<HTMLTextAreaElement>();

        // Bind event handlers so they are only bound once for every instance.
        this._onDetectSubmit = this._onDetectSubmit.bind(this);
        this._onMessageChange = this._onMessageChange.bind(this);
        this._onSmileySelect = this._onSmileySelect.bind(this);
        this._onSubmitMessage = this._onSubmitMessage.bind(this);
        this._toggleSmileysPanel = this._toggleSmileysPanel.bind(this);
    }

    /**
     * Implements React's {@link Component#componentDidMount()}.
     *
     * @inheritdoc
     */
    override componentDidMount() {
        if (isMobileBrowser()) {
            // Ensure textarea is not focused when opening chat on mobile browser.
            this._textArea?.current && this._textArea.current.blur();
        } else {
            this._focus();
        }
    }

    /**
     * Implements {@code Component#componentDidUpdate}.
     *
     * @inheritdoc
     */
    override componentDidUpdate(prevProps: Readonly<IProps>) {
        if (prevProps._privateMessageRecipientId !== this.props._privateMessageRecipientId) {
            this._textArea?.current?.focus();
        }
    }

    /**
     * Implements React's {@link Component#render()}.
     *
     * @inheritdoc
     * @returns {ReactElement}
     */
    override render() {
        const classes = withStyles.getClasses(this.props);
        const hideInput = this.props._isSendGroupChatDisabled && !this.props._privateMessageRecipientId;

        if (hideInput) {
            return (
                <div className = { classes.chatDisabled }>
                    {this.props.t('chat.disabled')}
                </div>
            );
        }

        return (
            <div className = { `chat-input-container${this.state.message.trim().length ? ' populated' : ''}` }>
                <div id = 'chat-input' >
                    {!this.props._areSmileysDisabled && this.state.showSmileysPanel && (
                        <div
                            className = 'smiley-input'>
                            <div
                                className = { classes.smileysPanel } >
                                <SmileysPanel
                                    onSmileySelect = { this._onSmileySelect } />
                            </div>
                        </div>
                    )}
                    <Input
                        className = 'chat-input'
                        icon = { this.props._areSmileysDisabled ? undefined : IconFaceSmile }
                        iconClick = { this._toggleSmileysPanel }
                        id = 'chat-input-messagebox'
                        maxRows = { 5 }
                        onChange = { this._onMessageChange }
                        onKeyPress = { this._onDetectSubmit }
                        placeholder = { this.props.t('chat.messagebox') }
                        ref = { this._textArea }
                        textarea = { true }
                        value = { this.state.message } />
                    <Button
                        accessibilityLabel = { this.props.t('chat.sendButton') }
                        disabled = { !this.state.message.trim() }
                        icon = { IconSend }
                        onClick = { this._onSubmitMessage }
                        size = { isMobileBrowser() ? 'large' : 'medium' } />
                </div>
            </div>
        );
    }

    /**
     * Place cursor focus on this component's text area.
     *
     * @private
     * @returns {void}
     */
    _focus() {
        this._textArea?.current && this._textArea.current.focus();
    }

    /**
     * Send message to external API for group chat (Everyone only)
     */
    _sendMessageToAPI = async (message: string): Promise<boolean> => {
        try {
            console.log('[_sendMessageToAPI] Starting to send message to API:', message);
            
            const meetLink = localStorage.getItem('meetLink');
            const token = localStorage.getItem('token');
            
            console.log('[_sendMessageToAPI] meetLink:', meetLink ? 'exists' : 'missing');
            console.log('[_sendMessageToAPI] token:', token ? 'exists' : 'missing');
            
            if (!meetLink || !token) {
                console.warn('[_sendMessageToAPI] Missing meetLink or token, cannot send message to API');
                return false;
            }
            
            console.log('[_sendMessageToAPI] Sending fetch request...');
            const response = await fetch('https://signal.kolla.click/api/v1/messages/create', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message,
                    meetLink,
                    token
                })
            });
            
            console.log('[_sendMessageToAPI] Response status:', response.status);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            console.log('[_sendMessageToAPI] Message sent to API successfully:', result);
            return true;
        } catch (error) {
            console.error('[_sendMessageToAPI] Error sending message to API:', error);
            return false;
        }
    };

    /**
     * Submits the message to the chat window.
     *
     * @returns {void}
     */
    _onSubmitMessage() {
        const {
            _isSendGroupChatDisabled,
            _privateMessageRecipientId,
            onSend
        } = this.props;

        console.log('[_onSubmitMessage] Called with:', {
            _isSendGroupChatDisabled,
            _privateMessageRecipientId,
            message: this.state.message
        });

        if (_isSendGroupChatDisabled && !_privateMessageRecipientId) {
            console.log('[_onSubmitMessage] Group chat disabled and no private recipient, returning');
            return;
        }

        const trimmed = this.state.message.trim();

        if (trimmed) {
            // Only send to API for group chat (Everyone) - not private messages
            if (!_privateMessageRecipientId) {
                console.log('[_onSubmitMessage] This is a group chat message (Everyone), sending to API');
                // Send to API asynchronously (don't block UI)
                this._sendMessageToAPI(trimmed).catch(error => {
                    console.error('[_onSubmitMessage] Failed to send message to API:', error);
                });
            } else {
                console.log('[_onSubmitMessage] This is a private message, skipping API call');
            }

            // Send message to conference (existing behavior)
            onSend(trimmed);

            this.setState({ message: '' });

            // Keep the textarea in focus when sending messages via submit button.
            this._focus();

            // Hide the Emojis box after submitting the message
            this.setState({ showSmileysPanel: false });
        } else {
            console.log('[_onSubmitMessage] Message is empty, not sending');
        }

    }

    /**
     * Detects if enter has been pressed. If so, submit the message in the chat
     * window.
     *
     * @param {string} event - Keyboard event.
     * @private
     * @returns {void}
     */
    _onDetectSubmit(event: any) {
        // Composition events used to add accents to characters
        // despite their absence from standard US keyboards,
        // to build up logograms of many Asian languages
        // from their base components or categories and so on.
        if (event.isComposing || event.keyCode === 229) {
            // keyCode 229 means that user pressed some button,
            // but input method is still processing that.
            // This is a standard behavior for some input methods
            // like entering japanese or сhinese hieroglyphs.
            return;
        }

        if (event.key === 'Enter'
            && event.shiftKey === false
            && event.ctrlKey === false) {
            event.preventDefault();
            event.stopPropagation();

            this._onSubmitMessage();
        }
    }

    /**
     * Updates the known message the user is drafting.
     *
     * @param {string} value - Keyboard event.
     * @private
     * @returns {void}
     */
    _onMessageChange(value: string) {
        this.setState({ message: value });
    }

    /**
     * Appends a selected smileys to the chat message draft.
     *
     * @param {string} smileyText - The value of the smiley to append to the
     * chat message.
     * @private
     * @returns {void}
     */
    _onSmileySelect(smileyText: string) {
        if (smileyText) {
            this.setState({
                message: `${this.state.message} ${smileyText}`,
                showSmileysPanel: false
            });
        } else {
            this.setState({
                showSmileysPanel: false
            });
        }

        this._focus();
    }

    /**
     * Callback invoked to hide or show the smileys selector.
     *
     * @private
     * @returns {void}
     */
    _toggleSmileysPanel() {
        if (this.state.showSmileysPanel) {
            this._focus();
        }
        this.setState({ showSmileysPanel: !this.state.showSmileysPanel });
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - Redux state.
 * @private
 * @returns {{
 *     _areSmileysDisabled: boolean
 * }}
 */
const mapStateToProps = (state: IReduxState) => {
    const { privateMessageRecipient, width } = state['features/chat'];
    const isGroupChatDisabled = isSendGroupChatDisabled(state);

    return {
        _areSmileysDisabled: areSmileysDisabled(state),
        _privateMessageRecipientId: privateMessageRecipient?.id,
        _isSendGroupChatDisabled: isGroupChatDisabled,
        _chatWidth: width.current ?? CHAT_SIZE,
    };
};

export default translate(connect(mapStateToProps)(withStyles(ChatInput, styles)));
