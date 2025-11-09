/* global $, APP, JitsiMeetJS */

import '@matrix-org/olm';
import 'focus-visible';
import './react/features/base/jitsi-local-storage/setup';
import conference from './conference';
import API from './modules/API';
import UI from './modules/UI/UI';
import translation from './modules/translation/translation';

// Initialize Olm as early as possible.
if (window.Olm) {
    window.Olm.init().catch(e => {
        console.error('Failed to initialize Olm, E2EE will be disabled', e);
        delete window.Olm;
    });
}

window.APP = {
    API,
    conference,
    translation,
    UI
};

// Import meeting mode feature
import './react/features/meeting-mode';

// Import the rest of the app
import './react';