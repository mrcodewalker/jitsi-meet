-- This module is activated under the main muc component
-- This will prevent anyone joining the call till jicofo and one moderator join the room
-- for the rest of the participants lobby will be turned on and they will be waiting there till
-- the main participant joins and lobby will be turned off at that time and rest of the participants will
-- join the room. It expects main virtual host to be set to require jwt tokens and guests to use
-- the guest domain which is anonymous.
-- The module has the option to set participants to moderators when connected via token/when they are authenticated
-- This module depends on mod_persistent_lobby.
local jid = require 'util.jid';
local util = module:require "util";
local is_admin = util.is_admin;
local is_healthcheck_room = util.is_healthcheck_room;
local is_moderated = util.is_moderated;
local process_host_module = util.process_host_module;

local disable_auto_owners = module:get_option_boolean('wait_for_host_disable_auto_owners', false);

local muc_domain_base = module:get_option_string('muc_mapper_domain_base');
if not muc_domain_base then
    module:log('warn', "No 'muc_mapper_domain_base' option set, disabling module");
    return
end

-- to activate this you need the following config in general config file in log = { }
-- { to = 'file', filename = '/var/log/prosody/prosody.audit.log', levels = { 'audit' }  }
local logger = require 'util.logger';
local audit_logger = logger.make_logger('mod_'..module.name, 'audit');

local lobby_muc_component_config = 'lobby.' .. muc_domain_base;
local lobby_host;

if not disable_auto_owners then
    -- CRITICAL: Run with HIGH priority (20) to check meetingRole BEFORE any other module can promote
    -- This ensures we block promotion early in the process
    -- CRITICAL: ADMIN should ALWAYS be promoted regardless of room.has_host status
    module:hook('muc-occupant-joined', function (event)
        local room, occupant, session = event.room, event.occupant, event.origin;
        local is_moderated_room = is_moderated(room.jid);

        -- Skip checks for admins and healthcheck rooms
        if is_admin(occupant.bare_jid) or is_healthcheck_room(room.jid) then
            return;
        end

        -- CRITICAL: Only check JWT authenticated users
        -- Require token to determine meetingRole
        -- Only if it is not a moderated room
        if not is_moderated_room and session.auth_token then
            -- Check if user has ADMIN meetingRole before promoting to moderator
            -- Only users with meetingRole === "ADMIN" should be promoted to moderator
            -- This prevents "first to join = moderator" behavior
            -- CRITICAL: ADMIN should be promoted REGARDLESS of room.has_host status
            local user_context = session.jitsi_meet_context_user;
            local meeting_role = nil;
            
            if user_context then
                -- ONLY check meetingRole field (not role field)
                meeting_role = user_context.meetingRole;
                module:log('info', 'wait_for_host: User context found for %s: meetingRole=%s, room.has_host=%s',
                    occupant.bare_jid,
                    tostring(meeting_role),
                    tostring(room.has_host));
            else
                module:log('warn', 'wait_for_host: No user context found for %s - cannot determine meetingRole', occupant.bare_jid);
            end

            -- CRITICAL: Only promote if meetingRole is explicitly "ADMIN"
            -- If meetingRole is missing, nil, "USER", or anything other than "ADMIN", do NOT promote
            -- Explicitly check that meetingRole is exactly "ADMIN" (case-sensitive string comparison)
            -- CRITICAL: ADMIN should be promoted even if room.has_host is true (user joining after first host)
            if meeting_role == "ADMIN" then
                -- Check current affiliation/role
                local current_affiliation = room:get_affiliation(occupant.bare_jid);
                local current_role = occupant.role;
                
                -- Only promote if not already owner/moderator
                if current_affiliation ~= 'owner' and current_role ~= 'moderator' then
                    module:log('info', 'wait_for_host: PROMOTING user %s to owner - meetingRole is ADMIN (room.has_host=%s)',
                        occupant.bare_jid, tostring(room.has_host));
                    room:set_affiliation(true, occupant.bare_jid, 'owner');
                else
                    module:log('info', 'wait_for_host: User %s already has owner/moderator - meetingRole is ADMIN', occupant.bare_jid);
                end
            else
                -- Explicitly block promotion for USER, nil, or any other value
                module:log('info', 'wait_for_host: SKIP promotion for user %s with meetingRole: %s (only ADMIN should be promoted)',
                    occupant.bare_jid,
                    tostring(meeting_role));
                
                -- CRITICAL: Also check if occupant was already promoted (by another module) and remove it
                if occupant.role == 'moderator' or room:get_affiliation(occupant.bare_jid) == 'owner' then
                    module:log('warn', 'wait_for_host: BLOCKED - Removing moderator/owner from %s (meetingRole is %s, not ADMIN)',
                        occupant.bare_jid, tostring(meeting_role));
                    room:set_affiliation(true, occupant.bare_jid, 'none');
                    room:set_role(occupant.nick, 'participant');
                end
            end
        elseif not is_moderated_room and not session.auth_token then
            -- No token means we cannot determine meetingRole, so do NOT promote
            module:log('info', 'wait_for_host: SKIP promotion for %s - no token (cannot determine meetingRole)', occupant.bare_jid);
            
            -- Also ensure non-authenticated users are not moderators
            if occupant.role == 'moderator' or room:get_affiliation(occupant.bare_jid) == 'owner' then
                module:log('warn', 'wait_for_host: BLOCKED - Removing moderator/owner from %s (no token)', occupant.bare_jid);
                room:set_affiliation(true, occupant.bare_jid, 'none');
                room:set_role(occupant.nick, 'participant');
            end
        end
    end, 20); -- HIGH priority to run BEFORE other modules that might promote
end

-- CRITICAL: Hook to ensure non-ADMIN users are set to participant BEFORE any other module can promote
-- Run with VERY HIGH priority (60) to run BEFORE mod_muc_allowners (priority 50)
module:hook('muc-occupant-pre-join', function (event)
    local room, occupant, session = event.room, event.occupant, event.origin;

    -- Skip checks for admins and healthcheck rooms
    if is_admin(occupant.bare_jid) or is_healthcheck_room(room.jid) then
        return;
    end

    -- CRITICAL: For all non-admin users, ensure they start as participant
    -- Check meetingRole and block any promotion if not ADMIN
    if session and session.auth_token then
        local user_context = session.jitsi_meet_context_user;
        local meeting_role = user_context and user_context.meetingRole;
        
        -- If meetingRole is not ADMIN, ensure role is participant and affiliation is none
        if meeting_role ~= "ADMIN" then
            -- Force set role to participant BEFORE any other module can change it
            occupant.role = 'participant';
            -- Also ensure affiliation is none
            local current_affiliation = room:get_affiliation(occupant.bare_jid);
            if current_affiliation == 'owner' then
                module:log('warn', 'wait_for_host pre-join: BLOCKED - Removing owner affiliation from %s (meetingRole is %s, not ADMIN)', 
                    occupant.bare_jid, tostring(meeting_role));
                room:set_affiliation(true, occupant.bare_jid, 'none');
            end
            -- Mark to prevent promotion
            occupant._block_moderator_promotion = true;
        end
    else
        -- No token means cannot determine meetingRole, so block promotion
        occupant.role = 'participant';
        occupant._block_moderator_promotion = true;
    end
end, 60); -- VERY HIGH priority to run BEFORE mod_muc_allowners

-- if not authenticated user is trying to join the room we enable lobby in it
-- and wait for the moderator to join
module:hook('muc-occupant-pre-join', function (event)
    local room, occupant, session = event.room, event.occupant, event.origin;

    -- Skip checks for admins and healthcheck rooms
    if is_admin(occupant.bare_jid) or is_healthcheck_room(room.jid) then
        return;
    end

    -- CRITICAL: Check if user is ADMIN - if so, allow them to join even if room.has_host is true
    -- This ensures ADMIN can always join and get moderator, regardless of when they join
    local is_admin_user = false;
    if session and session.auth_token then
        local user_context = session.jitsi_meet_context_user;
        local meeting_role = user_context and user_context.meetingRole;
        if meeting_role == "ADMIN" then
            is_admin_user = true;
            module:log('info', 'wait_for_host pre-join: ADMIN user detected - allowing join regardless of room.has_host');
        end
    end

    -- If room already has host and user is not ADMIN, skip processing
    -- But if user is ADMIN, continue processing to ensure they get proper role
    if room.has_host and not is_admin_user then
        return;
    end

    local has_host = false;
    for _, o in room:each_occupant() do
        if jid.host(o.bare_jid) == muc_domain_base then
            room.has_host = true;
        end
    end

    if not room.has_host or is_admin_user then
        if session.auth_token or (session.username and jid.host(occupant.bare_jid) == muc_domain_base) then
            -- the host is here, let's drop the lobby
            room:set_members_only(false);

            -- CRITICAL: Always set role to 'participant' by default, regardless of affiliation
            -- Only users with meetingRole === "ADMIN" should be promoted to moderator
            -- This prevents "first to join = moderator" behavior
            -- Do NOT use get_default_role as it may return 'moderator' if affiliation is 'owner'
            -- BUT: If user is ADMIN, don't force participant - let mod_muc_allowners promote them
            local user_context = session.jitsi_meet_context_user;
            local meeting_role = user_context and user_context.meetingRole;
            if meeting_role ~= "ADMIN" then
                occupant.role = 'participant';
                -- Ensure affiliation is 'none' for non-ADMIN users
                local current_affiliation = room:get_affiliation(occupant.bare_jid);
                if current_affiliation == 'owner' then
                    module:log('warn', 'BLOCKED: Removing owner affiliation from %s (meetingRole is %s, not ADMIN)', 
                        occupant.bare_jid, tostring(meeting_role));
                    room:set_affiliation(true, occupant.bare_jid, 'none');
                end
            else
                -- ADMIN user - don't force participant role, let promotion happen
                module:log('info', 'wait_for_host pre-join: ADMIN user - allowing role/affiliation to be set by other modules');
            end

            if not room.has_host then
                module:log('info', 'Host %s arrived in %s.', occupant.bare_jid, room.jid);
                audit_logger('room_jid:%s created_by:%s', room.jid,
                    session.jitsi_meet_context_user and session.jitsi_meet_context_user.id or 'nil');
                module:fire_event('room_host_arrived', room.jid, session);
                lobby_host:fire_event('destroy-lobby-room', {
                    room = room,
                    newjid = room.jid,
                    message = 'Host arrived.',
                });
            elseif is_admin_user then
                module:log('info', 'ADMIN user %s joining after first host - will be promoted to moderator', occupant.bare_jid);
            end
        elseif not room:get_members_only() then
            -- let's enable lobby
            module:log('info', 'Will wait for host in %s.', room.jid);
            prosody.events.fire_event('create-persistent-lobby-room', {
                room = room;
                reason = 'waiting-for-host',
                skip_display_name_check = true;
            });
        end
    end
end);

process_host_module(lobby_muc_component_config, function(host_module, host)
    -- lobby muc component created
    module:log('info', 'Lobby component loaded %s', host);
    lobby_host = module:context(host_module);
end);
