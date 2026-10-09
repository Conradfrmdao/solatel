#!/bin/bash
# The database, dumped in Postgres's own compressed format, one file a night,
# a fortnight of them. Run as the server's own user by solatel-backup.service,
# which reaches Postgres through its socket like the server does.
#
# Restore one into an empty database with
#   pg_restore --clean --if-exists -d solatel /var/backups/solatel/<file>
# with the server stopped (documents/RUNBOOK.md).
set -euo pipefail

DIR=/var/backups/solatel
KEEP_DAYS=14

stamp=$(date -u +%Y-%m-%dT%H%MZ)
pg_dump --format=custom --dbname=solatel --file="$DIR/solatel-$stamp.dump.part"
mv "$DIR/solatel-$stamp.dump.part" "$DIR/solatel-$stamp.dump"
find "$DIR" -name 'solatel-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$DIR" -name '*.part' -mmin +600 -delete
echo ">> backed up to $DIR/solatel-$stamp.dump ($(du -h "$DIR/solatel-$stamp.dump" | cut -f1))"
