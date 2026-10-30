# The backup service (deploy/backup/): Postgres's own tools for dumping and
# test-restoring, rclone for object storage, age for encryption.
FROM postgres:16-alpine
RUN apk add --no-cache rclone age tar gzip curl tzdata
COPY backup/*.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENTRYPOINT []
CMD ["schedule.sh"]
