--- activate under the main muc component
local filters = require 'util.filters';
local jid = require "util.jid";
local jid_bare = require "util.jid".bare;
local jid_host = require "util.jid".host;
local st = require "util.stanza";
local util = module:require "util";
local is_admin = util.is_admin;
local is_healthcheck_room = util.is_healthcheck_room;
local is_moderated = util.is_moderated;
local get_room_from_jid = util.get_room_from_jid;
local room_jid_match_rewrite = util.room_jid_match_rewrite;
local presence_check_status = util.presence_check_status;
local MUC_NS = 'http://jabber.org/protocol/muc';

local disable_revoke_owners;

local function load_config()
    disable_revoke_owners = module:get_option_boolean("allowners_disable_revoke_owners", false);
end
load_config();

-- List of the bare_jids of all occupants that are currently joining (went through pre-join) and will be promoted
-- as moderators. As pre-join (where added) and joined event (where removed) happen one after another this list should
-- have length of 1
local joining_moderator_participants = module:shared('moderators/joining_moderator_participants');

module:hook("muc-room-created", function(event)
    local room = event.room;

    if room.jitsiMetadata then
        room.jitsiMetadata.allownersEnabled = true;
    end
end, -2); -- room_metadata should run before this module on -1

-- CRITICAL: Run with VERY HIGH priority (50) to check meetingRole BEFORE any other module can promote
-- This ensures we block promotion early in the process
module:hook("muc-occupant-pre-join", function (event)
    local room, occupant = event.room, event.occupant;

    if is_healthcheck_room(room.jid) or is_admin(occupant.bare_jid) then
        return;
    end

    local moderated, room_name, subdomain = is_moderated(room.jid);
    local session = event.origin;
    local token = session.auth_token;

    -- CRITICAL: Require token for ALL rooms (both moderated and non-moderated)
    -- Without token, we cannot determine meetingRole, so do NOT promote
    if not token then
        module:log('info', 'SKIP allowners promotion for %s - no token (cannot determine meetingRole)', occupant.bare_jid);
        -- Mark occupant to prevent any promotion
        occupant._block_moderator_promotion = true;
        return;
    end

    -- For moderated rooms, check room matching
    if moderated then
        if not (room_name == session.jitsi_meet_room or session.jitsi_meet_room == '*') then
            module:log('debug', 'skip allowners for auth user and non matching room name: %s, jwt room name: %s',
                room_name, session.jitsi_meet_room);
            return;
        end

        if session.jitsi_meet_domain ~= '*' and subdomain ~= session.jitsi_meet_domain then
            module:log('debug', 'skip allowners for auth user and non matching room subdomain: %s, jwt subdomain: %s',
                subdomain, session.jitsi_meet_domain);
            return;
        end
    end

    -- CRITICAL: ALWAYS check meetingRole for ALL rooms
    -- Only users with meetingRole === "ADMIN" should be promoted to moderator
    -- This prevents "first to join = moderator" behavior
    local user_context = session.jitsi_meet_context_user;
    local meeting_role = nil;
    
    if user_context then
        -- ONLY check meetingRole field (not role field)
        meeting_role = user_context.meetingRole;
        -- Debug: log full user context to see what fields are available
        module:log('info', 'User context found for %s: meetingRole=%s, full context keys: %s',
            occupant.bare_jid,
            tostring(meeting_role),
            user_context and next(user_context) and table.concat({}, ', ') or 'empty');
        -- Log all keys in user_context for debugging
        if user_context then
            local keys = {};
            for k, v in pairs(user_context) do
                table.insert(keys, string.format('%s=%s', k, tostring(v)));
            end
            module:log('debug', 'Full user_context for %s: %s', occupant.bare_jid, table.concat(keys, ', '));
        end
    else
        module:log('warn', 'No user context found for %s in session - cannot determine meetingRole', occupant.bare_jid);
    end

    -- CRITICAL: Only promote if meetingRole is explicitly "ADMIN"
    -- If meetingRole is missing, nil, "USER", or anything other than "ADMIN", do NOT promote
    -- Explicitly check that meetingRole is exactly "ADMIN" (case-sensitive string comparison)
    if meeting_role ~= "ADMIN" then
        module:log('info', 'SKIP allowners promotion for user %s with meetingRole: %s (only ADMIN should be promoted)',
            occupant.bare_jid,
            tostring(meeting_role));
        -- Mark occupant to prevent any promotion by other modules
        occupant._block_moderator_promotion = true;
        return;
    end

    -- Only reached if meetingRole is exactly "ADMIN"
    module:log('info', 'PROMOTING user %s to moderator - meetingRole is ADMIN', occupant.bare_jid);
    joining_moderator_participants[occupant.bare_jid] = true;
end, 50); -- VERY HIGH priority to run BEFORE other modules that might promote

-- CRITICAL: Run with VERY HIGH priority (25) to check and block unauthorized promotions
-- This ensures we check meetingRole BEFORE any other module can promote
module:hook("muc-occupant-joined", function (event)
    local room, occupant = event.room, event.occupant;

    -- Skip checks for admins and healthcheck rooms
    if is_admin(occupant.bare_jid) or is_healthcheck_room(room.jid) then
        return;
    end

    -- First, check if this occupant was marked to block promotion
    if occupant._block_moderator_promotion then
        -- If occupant has moderator role but was marked to block, remove it
        if occupant.role == 'moderator' or room:get_affiliation(occupant.bare_jid) == 'owner' then
            module:log('warn', 'BLOCKED: Removing moderator/owner from %s (meetingRole is not ADMIN)', occupant.bare_jid);
            room:set_affiliation(true, occupant.bare_jid, "none");
            room:set_role(occupant.nick, 'participant');
        end
        occupant._block_moderator_promotion = nil;
    end

    local promote_to_moderator = joining_moderator_participants[occupant.bare_jid];
    -- clear it
    joining_moderator_participants[occupant.bare_jid] = nil;

    if promote_to_moderator ~= nil then
        -- Double-check meetingRole before promoting (safety check)
        local session = event.origin;
        local user_context = session and session.jitsi_meet_context_user;
        local meeting_role = user_context and user_context.meetingRole;
        
        -- Explicitly check that meetingRole is exactly "ADMIN"
        if meeting_role == "ADMIN" then
            module:log('info', 'CONFIRMED: Promoting user %s to owner - meetingRole is ADMIN', occupant.bare_jid);
            room:set_affiliation(true, occupant.bare_jid, "owner");
        else
            module:log('warn', 'BLOCKED: Attempted to promote user %s but meetingRole is %s (not ADMIN)', 
                occupant.bare_jid, tostring(meeting_role));
            -- Ensure they are not moderators
            if occupant.role == 'moderator' or room:get_affiliation(occupant.bare_jid) == 'owner' then
                room:set_affiliation(true, occupant.bare_jid, "none");
                room:set_role(occupant.nick, 'participant');
            end
        end
    else
        -- CRITICAL: Even if not in our promotion list, check if someone else promoted them
        -- This catches any promotion by other modules or default behavior
        if occupant.role == 'moderator' or room:get_affiliation(occupant.bare_jid) == 'owner' then
            local session = event.origin;
            local user_context = session and session.jitsi_meet_context_user;
            local meeting_role = user_context and user_context.meetingRole;
            
            -- CRITICAL: Only allow moderator/owner if meetingRole is exactly "ADMIN"
            if meeting_role ~= "ADMIN" then
                module:log('warn', 'BLOCKED: User %s was promoted to moderator/owner but meetingRole is %s (not ADMIN) - removing moderator/owner',
                    occupant.bare_jid, tostring(meeting_role));
                room:set_affiliation(true, occupant.bare_jid, "none");
                room:set_role(occupant.nick, 'participant');
            else
                module:log('info', 'ALLOWED: User %s is moderator/owner with meetingRole ADMIN', occupant.bare_jid);
            end
        end
    end
end, 25); -- VERY HIGH priority to run BEFORE other modules

module:hook_global('config-reloaded', load_config);

-- Filters self-presences to a jid that exist in joining_participants array
-- We want to filter those presences where we send first `participant` and just after it `moderator`
function filter_stanza(stanza)
    -- when joining_moderator_participants is empty there is nothing to filter
    if next(joining_moderator_participants) == nil
            or not stanza.attr
            or not stanza.attr.to
            or stanza.name ~= "presence" then
        return stanza;
    end

    -- we want to filter presences only on this host for allowners and skip anything like lobby etc.
    local host_from = jid_host(room_jid_match_rewrite(stanza.attr.from));
    if host_from ~= module.host then
        return stanza;
    end

    local bare_to = jid_bare(stanza.attr.to);
    if stanza:get_error() and joining_moderator_participants[bare_to] then
        -- pre-join succeeded but joined did not so we need to clear cache
        joining_moderator_participants[bare_to] = nil;
        return stanza;
    end

    local muc_x = stanza:get_child('x', MUC_NS..'#user');
    if not muc_x then
        return stanza;
    end

    if joining_moderator_participants[bare_to] and presence_check_status(muc_x, '110') then
        -- skip the local presence for participant
        return nil;
    end

    -- skip sending the 'participant' presences to all other people in the room
    for item in muc_x:childtags('item') do
        if joining_moderator_participants[jid_bare(item.attr.jid)] then
            return nil;
        end
    end

    return stanza;
end
function filter_session(session)
    -- domain mapper is filtering on default priority 0, and we need it after that
    filters.add_filter(session, 'stanzas/out', filter_stanza, -1);
end

-- enable filtering presences
filters.add_filter_hook(filter_session);

-- CRITICAL: Hook to filter/modify presence before broadcasting to clients
-- This ensures ChatRoom.js receives correct role information
-- Run with HIGH priority to modify presence before it's sent
module:hook('muc-broadcast-presence', function(event)
    local occupant, room, x = event.occupant, event.room, event.x;
    
    -- Skip checks for admins and healthcheck rooms
    if is_admin(occupant.bare_jid) or is_healthcheck_room(room.jid) then
        return;
    end
    
    -- Ensure x element exists
    if not x then
        return;
    end
    
    -- Get session to check meetingRole
    local sessions = prosody.full_sessions;
    local session = sessions[occupant.jid];
    
    local item = x:get_child('item');
    if not item then
        return;
    end
    
    local role_attr = item.attr.role;
    local affiliation_attr = item.attr.affiliation;
    
    -- Check if presence has role='moderator' or affiliation='owner'
    if role_attr == 'moderator' or affiliation_attr == 'owner' then
        local meeting_role = nil;
        
        if session then
            local user_context = session.jitsi_meet_context_user;
            meeting_role = user_context and user_context.meetingRole;
        end
        
        -- CRITICAL: If meetingRole is not ADMIN, change role/affiliation in presence
        if meeting_role ~= "ADMIN" then
            module:log('warn', 'muc-broadcast-presence: BLOCKED - Changing role/affiliation in presence for %s (meetingRole is %s, not ADMIN)',
                occupant.bare_jid, tostring(meeting_role));
            
            -- Force set role to participant
            item.attr.role = 'participant';
            -- Force set affiliation to none
            item.attr.affiliation = 'none';
        end
    end
end, 10); -- HIGH priority to modify presence before it's sent

-- Hook to intercept and validate any affiliation changes to 'owner'
-- This prevents unauthorized promotions even if other modules try to promote
-- CRITICAL: Run with VERY LOW priority (-50) to intercept BEFORE any other module can set affiliation
module:hook('muc-pre-set-affiliation', function(event)
    local jid, room, affiliation = event.jid, event.room, event.affiliation;
    
    -- Only check when trying to set affiliation to 'owner' (moderator)
    if affiliation ~= 'owner' then
        return;
    end
    
    -- Skip checks for admins and healthcheck rooms
    if is_admin(jid) or is_healthcheck_room(room.jid) then
        return;
    end
    
    module:log('info', 'INTERCEPTED: Attempt to set owner affiliation for %s in room %s', jid, room.jid);
    
    -- Find the occupant to get their session
    local occupant = nil;
    for _, o in room:each_occupant() do
        if o.bare_jid == jid then
            occupant = o;
            break;
        end
    end
    
    if not occupant then
        -- Occupant not found, might be setting affiliation before join
        -- We'll check in the session if available
        local actor = event.actor;
        if actor then
            local sessions = prosody.full_sessions;
            local session = sessions[actor];
            if session then
                local user_context = session.jitsi_meet_context_user;
                local meeting_role = user_context and user_context.meetingRole;
                
                -- Explicitly check that meetingRole is exactly "ADMIN"
                if meeting_role ~= "ADMIN" then
                    module:log('warn', 'BLOCKED: Attempt to set owner affiliation for %s with meetingRole: %s (not ADMIN)', 
                        jid, tostring(meeting_role));
                    event.affiliation = nil; -- Block the affiliation change
                    return;
                end
            end
        end
        return;
    end
    
    -- Get session from occupant
    local sessions = prosody.full_sessions;
    local session = sessions[occupant.jid];
    
    if session then
        local user_context = session.jitsi_meet_context_user;
        local meeting_role = user_context and user_context.meetingRole;
        
        -- CRITICAL: Only allow if meetingRole is exactly "ADMIN"
        -- Explicitly check that meetingRole is "ADMIN" (not nil, not "USER", not anything else)
        if meeting_role ~= "ADMIN" then
            module:log('warn', 'BLOCKED: Attempt to set owner affiliation for %s with meetingRole: %s (not ADMIN)', 
                jid, tostring(meeting_role));
            event.affiliation = nil; -- Block the affiliation change
            return;
        else
            module:log('info', 'ALLOWED: Setting owner affiliation for %s - meetingRole is ADMIN', jid);
        end
    else
        -- No session found, block to be safe
        module:log('warn', 'BLOCKED: Attempt to set owner affiliation for %s but no session found', jid);
        event.affiliation = nil;
        return;
    end
end, -50); -- VERY LOW priority to intercept BEFORE any other module can set affiliation

-- Hook to intercept and validate any role changes to 'moderator'
-- This prevents unauthorized role promotions even if other modules try to set role directly
-- CRITICAL: Run with VERY LOW priority (-50) to intercept BEFORE any other module can set role
module:hook('muc-set-role', function(event)
    local room, occupant, role = event.room, event.occupant, event.role;
    
    -- Only check when trying to set role to 'moderator'
    if role ~= 'moderator' then
        return;
    end
    
    -- Skip checks for admins and healthcheck rooms
    if is_admin(occupant.bare_jid) or is_healthcheck_room(room.jid) then
        return;
    end
    
    module:log('info', 'INTERCEPTED: Attempt to set moderator role for %s in room %s', occupant.bare_jid, room.jid);
    
    -- Get session from occupant
    local sessions = prosody.full_sessions;
    local session = sessions[occupant.jid];
    
    if session then
        local user_context = session.jitsi_meet_context_user;
        local meeting_role = user_context and user_context.meetingRole;
        
        -- CRITICAL: Only allow if meetingRole is exactly "ADMIN"
        if meeting_role ~= "ADMIN" then
            module:log('warn', 'BLOCKED: Attempt to set moderator role for %s with meetingRole: %s (not ADMIN)', 
                occupant.bare_jid, tostring(meeting_role));
            event.role = nil; -- Block the role change
            return;
        else
            module:log('info', 'ALLOWED: Setting moderator role for %s - meetingRole is ADMIN', occupant.bare_jid);
        end
    else
        -- No session found, block to be safe
        module:log('warn', 'BLOCKED: Attempt to set moderator role for %s but no session found', occupant.bare_jid);
        event.role = nil;
        return;
    end
end, -50); -- VERY LOW priority to intercept BEFORE any other module can set role

-- filters any attempt to revoke owner rights on non moderated rooms
function filter_admin_set_query(event)
    local origin, stanza = event.origin, event.stanza;
    local room_jid = jid_bare(stanza.attr.to);
    local room = get_room_from_jid(room_jid);

    local item = stanza.tags[1].tags[1];
    local _aff = item.attr.affiliation;

    -- if it is a moderated room we skip it
    if room and is_moderated(room.jid) then
        return nil;
    end

    -- any revoking is disabled, everyone should be owners
    if _aff == 'none' or _aff == 'outcast' or _aff == 'member' then
        origin.send(st.error_reply(stanza, "auth", "forbidden"));
        return true;
    end
end

if not disable_revoke_owners then
    -- default prosody priority for handling these is -2
    module:hook("iq-set/bare/http://jabber.org/protocol/muc#admin:query", filter_admin_set_query, 5);
    module:hook("iq-set/host/http://jabber.org/protocol/muc#admin:query", filter_admin_set_query, 5);
end
