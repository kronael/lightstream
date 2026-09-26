BUN ?= bun
LIGHTBRINGER ?= ../lightbringer

.PHONY: build lint fmt test clean compile proto-sync

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

proto-sync:
	cp $(LIGHTBRINGER)/pb/slot_stream.proto $(LIGHTBRINGER)/pb/slot_entry.proto proto/pb/
