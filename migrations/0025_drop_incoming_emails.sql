-- Drop incoming_emails table.
--
-- Sprint 20 PR1 (#94) introduced this table along with the email_inbox
-- action_type for receiving inbound emails via webhook / Cloudflare Email
-- Routing. Sprint 20 PR2 (#95) added the Cloudflare Email Workers handler.
--
-- Both PRs have been reverted at the user's request because the email
-- inbox feature is no longer needed.
--
-- The corresponding 0022 migration that created this table was reverted
-- in source, but production D1 already has the table applied.
-- This migration drops it cleanly so that the schema matches the reverted code.

DROP TABLE IF EXISTS `incoming_emails`;
