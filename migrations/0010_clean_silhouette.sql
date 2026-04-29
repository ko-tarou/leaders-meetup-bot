ALTER TABLE `meetings` ADD `event_id` text REFERENCES events(id);
--> statement-breakpoint
-- ADR-0005 Step 2: default event INSERT + meetings backfill (冪等)
INSERT OR IGNORE INTO events (id, type, name, config, status, created_at)
VALUES ('evt_default_meetup', 'meetup', 'リーダー雑談会', '{}', 'active', '2026-04-29T00:00:00.000Z');
--> statement-breakpoint
UPDATE meetings SET event_id = 'evt_default_meetup' WHERE event_id IS NULL;