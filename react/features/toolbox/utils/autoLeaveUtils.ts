/**
 * Utility functions for automatic leave detection when user closes tab or navigates away
 */

/**
 * Sends leave request to attendance log API
 * @returns {Promise<boolean>} - Returns true if successful, false otherwise
 */
export const sendLeaveRequest = async (): Promise<boolean> => {
    try {
        // Always get fresh data from localStorage
        const currentData = getCurrentAttendanceData();
        
        if (!currentData) {
            console.log('No attendance log ID or token found, skipping leave request');
            return false;
        }
        
        const { attendanceLogId, token } = currentData;
        console.log('Current attendance data - ID:', attendanceLogId, 'Token:', token);

        // Use sendBeacon for more reliable delivery when page is unloading
        const url = `https://signal.kolla.click/api/v1/attendance-logs/${attendanceLogId}/leave-with-token`;
        const data = JSON.stringify({ token });
        
        console.log('Sending leave request for attendance log:', attendanceLogId);
        
        // Try sendBeacon first (more reliable for page unload)
        if (navigator.sendBeacon) {
            const blob = new Blob([data], { type: 'application/json' });
            const success = navigator.sendBeacon(url, blob);
            if (success) {
                console.log('Leave request sent via sendBeacon for ID:', attendanceLogId);
                return true;
            }
        }
        
        // Fallback to fetch if sendBeacon fails or is not available
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: data,
        });
        
        if (response.ok) {
            console.log('Leave request sent successfully for ID:', attendanceLogId);
            return true;
        } else {
            console.error('Leave request failed for ID:', attendanceLogId, 'Status:', response.status);
            return false;
        }
        
    } catch (error) {
        console.error('Error sending leave request:', error);
        return false;
    }
};

/**
 * Clears attendance-related localStorage items
 */
export const clearAttendanceData = () => {
    localStorage.removeItem('attendanceLogId');
    localStorage.removeItem('meetLink');
    localStorage.removeItem('token');
};

/**
 * Safely updates attendance log data in localStorage
 * @param attendanceLogId - New attendance log ID
 * @param token - New token
 * @returns {boolean} - Returns true if update was successful
 */
export const updateAttendanceData = (attendanceLogId: string, token: string): boolean => {
    try {
        const oldId = localStorage.getItem('attendanceLogId');
        const oldToken = localStorage.getItem('token');
        
        console.log('Updating attendance data from ID:', oldId, 'to:', attendanceLogId);
        
        // Store new data
        localStorage.setItem('attendanceLogId', attendanceLogId);
        localStorage.setItem('token', token);
        
        // Verify the update
        const storedId = localStorage.getItem('attendanceLogId');
        const storedToken = localStorage.getItem('token');
        
        if (storedId === attendanceLogId && storedToken === token) {
            console.log('✅ Attendance data successfully updated and verified');
            return true;
        } else {
            console.error('❌ Failed to update attendance data - verification failed');
            return false;
        }
    } catch (error) {
        console.error('❌ Error updating attendance data:', error);
        return false;
    }
};

/**
 * Gets current attendance log data from localStorage
 * @returns {object} - Returns current attendance data or null if not available
 */
export const getCurrentAttendanceData = () => {
    const attendanceLogId = localStorage.getItem('attendanceLogId');
    const token = localStorage.getItem('token');
    const meetLink = localStorage.getItem('meetLink');
    
    if (attendanceLogId && token) {
        return {
            attendanceLogId,
            token,
            meetLink
        };
    }
    
    return null;
};

/**
 * Creates a new attendance log entry using existing token
 * @returns {Promise<{success: boolean, data?: any}>} - Returns success status and data if successful
 */
export const createAttendanceLog = async (): Promise<{success: boolean, data?: any}> => {
    try {
        const meetLink = localStorage.getItem('meetLink');
        const token = localStorage.getItem('token');
        
        if (!meetLink || !token) {
            console.log('No meet link or token found, cannot create attendance log');
            return { success: false };
        }

        const response = await fetch('https://signal.kolla.click/api/v1/attendance-logs/create-with-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: token,
                meetLink: meetLink,
                action: 'join'
            })
        });

        if (response.ok) {
            const data = await response.json();
            console.log('New attendance log created:', data);
            
            // Store new attendance log data using safe update function
            if (data.data && data.data.id) {
                const updateSuccess = updateAttendanceData(data.data.id.toString(), token);
                if (!updateSuccess) {
                    console.error('❌ Failed to update attendance data');
                    return { success: false };
                }
                console.log('🎯 Ready for next leave event with attendance log ID:', data.data.id);
            } else {
                console.error('❌ Invalid attendance log data received:', data);
                return { success: false };
            }
            
            return { success: true, data };
        } else {
            console.error('Failed to create attendance log:', response.status);
            return { success: false };
        }
        
    } catch (error) {
        console.error('Error creating attendance log:', error);
        return { success: false };
    }
};

/**
 * Initializes attendance tracking by creating the first attendance log
 * This should be called when user joins the meeting
 * @param meetLink - The meeting link
 * @param token - The user token
 * @returns {Promise<{success: boolean, data?: any}>} - Returns success status and data if successful
 */
export const initializeAttendanceTracking = async (meetLink: string, token: string): Promise<{success: boolean, data?: any}> => {
    try {
        console.log('🚀 Initializing attendance tracking...');
        
        // Store meet link and token first
        localStorage.setItem('meetLink', meetLink);
        localStorage.setItem('token', token);
        
        // Create first attendance log
        const result = await createAttendanceLog();
        
        if (result.success) {
            console.log('✅ Attendance tracking initialized successfully');
            console.log('🎯 Ready for automatic leave detection');
        } else {
            console.error('❌ Failed to initialize attendance tracking');
            clearAttendanceData();
        }
        
        return result;
    } catch (error) {
        console.error('Error initializing attendance tracking:', error);
        clearAttendanceData();
        return { success: false };
    }
};

/**
 * Handles automatic leave when user closes tab or navigates away
 */
export const handleAutoLeave = async () => {
    try {
        // Send leave request first
        await sendLeaveRequest();
        
        // Clear localStorage
        clearAttendanceData();
        
        console.log('Auto-leave completed successfully');
    } catch (error) {
        console.error('Error during auto-leave:', error);
        // Still clear localStorage even if request fails
        clearAttendanceData();
    }
};

/**
 * Sets up event listeners for automatic leave detection
 * @param onLeave - Callback function to call when leave is detected
 */
export const setupAutoLeaveListeners = (onLeave: () => void) => {
    let isLeaving = false;
    let visibilityTimeout: NodeJS.Timeout | null = null;
    let focusTimeout: NodeJS.Timeout | null = null;
    
    const triggerLeave = async (reason: 'page_unload' | 'visibility_change' | 'focus_loss' = 'page_unload') => {
        if (isLeaving) return;
        isLeaving = true;
        
        console.log(`Auto-leave triggered due to: ${reason}`);
        
        // Always get fresh data from localStorage
        const currentData = getCurrentAttendanceData();
        
        if (!currentData) {
            console.log('No attendance data available for leave request');
            isLeaving = false;
            return;
        }
        
        const { attendanceLogId, token } = currentData;
        console.log('Current attendance data for leave - ID:', attendanceLogId, 'Token:', token);
        
        if (attendanceLogId && token) {
            const url = `https://signal.kolla.click/api/v1/attendance-logs/${attendanceLogId}/leave-with-token`;
            const data = JSON.stringify({ token });
            
            console.log('Sending leave request for attendance log:', attendanceLogId);
            
            let leaveSuccess = false;
            
            if (reason === 'page_unload') {
                // For page unload, use sendBeacon (most reliable)
                if (navigator.sendBeacon) {
                    const blob = new Blob([data], { type: 'application/json' });
                    leaveSuccess = navigator.sendBeacon(url, blob);
                    console.log('SendBeacon result for ID:', attendanceLogId, 'Success:', leaveSuccess);
                }
            } else {
                // For visibility change or focus loss, use fetch (more reliable for async operations)
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: data
                    });
                    leaveSuccess = response.ok;
                    console.log('Fetch leave result for ID:', attendanceLogId, 'Success:', leaveSuccess);
                } catch (error) {
                    console.error('Error sending leave request for ID:', attendanceLogId, error);
                }
            }
            
            // Only clear localStorage for page unload or failed leave
            if (reason === 'page_unload' || !leaveSuccess) {
                console.log('Clearing attendance data (page unload or failed leave)');
                clearAttendanceData();
            }
            // For visibility change and focus loss, keep data for potential return
        }
        
        // Reset isLeaving flag after processing
        isLeaving = false;
        
        // Call the callback for any additional cleanup
        onLeave();
    };

    // Handle page unload (closing tab, navigating away, refresh)
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        console.log('beforeunload event triggered');
        triggerLeave('page_unload');
    };

    // Handle page hide (more reliable than beforeunload on some browsers)
    const handlePageHide = () => {
        console.log('pagehide event triggered');
        triggerLeave('page_unload');
    };

    // Handle visibility change (switching tabs, minimizing window)
    const handleVisibilityChange = () => {
        if (document.hidden) {
            console.log('Page became hidden');
            // Clear any existing timeout
            if (visibilityTimeout) {
                clearTimeout(visibilityTimeout);
            }
            // Only trigger if page becomes hidden for more than 5 seconds
            visibilityTimeout = setTimeout(async () => {
                if (document.hidden && !isLeaving) {
                    console.log('Page still hidden after 5 seconds, triggering leave');
                    await triggerLeave('visibility_change');
                }
            }, 5000);
        } else {
            // Page became visible, clear timeout
            if (visibilityTimeout) {
                clearTimeout(visibilityTimeout);
                visibilityTimeout = null;
            }
            
            // When user returns to the page, create new attendance log
            console.log('Page became visible - user returned, creating new attendance log...');
            setTimeout(async () => {
                const currentData = getCurrentAttendanceData();
                if (currentData) {
                    console.log('Creating new attendance log for return...');
                    const createResult = await createAttendanceLog();
                    if (createResult.success) {
                        console.log('✅ New attendance log created for return');
                        console.log('🎯 Ready for next leave event');
                    } else {
                        console.log('❌ Failed to create new attendance log for return');
                    }
                } else {
                    console.log('No attendance data found, skipping new log creation');
                }
            }, 1000); // Small delay to ensure page is fully loaded
        }
    };

    // Handle page focus loss (clicking outside window, alt-tab, etc.)
    const handleFocusLoss = () => {
        // Clear any existing timeout
        if (focusTimeout) {
            clearTimeout(focusTimeout);
        }
        focusTimeout = setTimeout(async () => {
            if (!document.hasFocus() && !isLeaving) {
                console.log('Page lost focus, triggering leave');
                await triggerLeave('focus_loss');
            }
        }, 5000); // 5 seconds delay
    };

    // Handle beforeunload with unload as backup
    const handleUnload = () => {
        console.log('unload event triggered');
        triggerLeave('page_unload');
    };

    // Add event listeners with different priorities
    window.addEventListener('beforeunload', handleBeforeUnload, { capture: true });
    window.addEventListener('pagehide', handlePageHide, { capture: true });
    window.addEventListener('unload', handleUnload, { capture: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleFocusLoss);

    // Return cleanup function
    return () => {
        // Clear timeouts
        if (visibilityTimeout) {
            clearTimeout(visibilityTimeout);
        }
        if (focusTimeout) {
            clearTimeout(focusTimeout);
        }
        
        window.removeEventListener('beforeunload', handleBeforeUnload, { capture: true });
        window.removeEventListener('pagehide', handlePageHide, { capture: true });
        window.removeEventListener('unload', handleUnload, { capture: true });
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('blur', handleFocusLoss);
    };
};
