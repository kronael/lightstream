BUN ?= bun
LIGHTBRINGER ?= ../lightbringer
PREFIX ?= /usr/local

.PHONY: build lint fmt test clean compile install proto-sync

build:
	$(BUN) install
	$(BUN) x tsc --noEmit

lint:
	$(BUN) x biome check
	$(BUN) x tsc --noEmit

fmt:
	$(BUN) x biome check --write

test:
	$(BUN) test

clean:
	rm -f lightstream.sqlite lightstream.sqlite-wal lightstream.sqlite-shm

compile:
	$(BUN) build --compile --outfile dist/lightstream bin/lightstream.ts

install: compile
	install -Dm755 dist/lightstream $(DESTDIR)$(PREFIX)/bin/lightstream
	install -Dm644 proto/pb/slot_stream.proto \
	  $(DESTDIR)$(PREFIX)/share/lightstream/proto/pb/slot_stream.proto
	install -Dm644 proto/pb/slot_entry.proto \
	  $(DESTDIR)$(PREFIX)/share/lightstream/proto/pb/slot_entry.proto

proto-sync:
	cp $(LIGHTBRINGER)/pb/slot_stream.proto $(LIGHTBRINGER)/pb/slot_entry.proto proto/pb/
