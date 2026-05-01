-- Drop gmail_integrations table.
--
-- Sprint 21 PR1 (#96) introduced this table along with Gmail OAuth integration.
-- That PR has been reverted because Gmail API requires CASA Tier 2 audit
-- for self-service OAuth distribution, which is out of scope for this PoC.
--
-- The corresponding 0023 migration that created this table was reverted
-- in source, but production D1 already has the table applied.
-- This migration drops it cleanly so that the schema matches the reverted code.

DROP TABLE IF EXISTS `gmail_integrations`;
