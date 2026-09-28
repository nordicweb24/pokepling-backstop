# pokepling-backstop

A scheduled reader for [PokePling](https://pokepling.com), the Norwegian Pokémon
TCG restock tracker.

## What this is

Some of the shops PokePling watches sit behind bot protection that refuses
requests from the serverless workers the rest of the service runs on. The
workaround has been a script on an ordinary machine — which works, until that
machine crashes, sleeps, or is simply switched off for the night. On one
measured day that came to 9 hours 41 minutes with nobody watching the shops.

This repository is the floor under that. Every five minutes a runner asks the
service whether the fast reader is alive. If it is, the run exits in a couple of
seconds and costs nothing. If it is not, the runner reads the shops itself and
posts what it finds, so the gap is minutes instead of hours.

It is deliberately a floor and not a replacement: five minutes is the fastest
schedule GitHub offers, and a restock tracker wants to be quicker than that when
it can be.

## What it is not

Not a server. Each run is short and finishes; nothing loops in the background.

## What it knows

Nothing worth hiding, which is why this can be public. There are no shop names,
no URLs and no credentials in this repository — the run asks the service what to
read, over an authenticated endpoint, and the service answers. The one secret is
`INGEST_TOKEN`, and it opens exactly two endpoints: "what should I read" and
"here is what I read". It cannot touch accounts, alerts or anything else.

## Setup

1. Add `INGEST_TOKEN` under **Settings → Secrets and variables → Actions**.
2. That is the whole setup. The schedule starts on its own.

Run it by hand from the **Actions** tab — tick *force* to make it feed even when
the fast reader looks healthy.

## Anything alarming

If every shop in a run fails, the job fails loudly rather than reporting a quiet
success: that would mean this route has started being refused too, and it should
be noticed the same day rather than discovered weeks later.
