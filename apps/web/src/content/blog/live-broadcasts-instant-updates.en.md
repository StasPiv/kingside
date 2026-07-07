---
slug: live-broadcasts-instant-updates
locale: en
title: "Live broadcasts are faster: every ongoing round now updates in seconds"
description: "Previously, moves arrived instantly only on the eight most popular rounds, while everything else refreshed once every five minutes. That gap is gone — any ongoing game in any round now gets a fresh move within seconds."
tags: ["broadcast", "product"]
author: kingside
status: published
publishedAt: "2026-07-07"
coverUrl: "/og/broadcast-instant.en.png"
coverAlt: "Kingside — Live broadcasts, now truly live"
---

# Live broadcasts are faster: every ongoing round now updates in seconds

Kingside broadcasts used to have a visible split: on the "top" rounds moves arrived instantly, while everything else refreshed once every five minutes. Starting today that split is gone — any ongoing game in any round gets a fresh move within seconds.

## Why it used to be slow

Kingside pulls broadcast moves from the Lichess Broadcast API. That API has a firm rule: one IP address can hold at most eight simultaneous round-stream subscriptions at a time. Until now, every subscription was opened by our server — so the entire site shared those same eight slots. With twenty to twenty-five ongoing rounds in the schedule (and more during major tournaments), a choice had to be made: eight of the most-watched rounds got real-time moves, everything else caught up through periodic polls once every five minutes.

The result was noticeable: on the popular boards you saw a live game, and on a side board you were watching yesterday's news.

## What changed

Now the move stream is opened not by our server, but by each viewer's browser — directly against the source. Every visitor has their own IP, so the eight-slot limit applies to them individually rather than to the whole site. Every ongoing round is equally available for realtime viewing, regardless of how popular it is. From the moment a move is played to the moment it shows up on the board — a few seconds.

## What if the direct connection doesn't work

Not every network has the same outbound access: corporate firewalls, privacy extensions, or temporary internet hiccups can all close the direct channel. The site detects this on its own and switches to a fallback route through our server. In that mode the delay is at most 30 seconds for actively watched rounds and at most five minutes for the rest. There is no "board sits with no data" state.

## A side effect: less infrastructure

An entire internal layer disappeared — the one that used to decide "who gets one of the eight slots": viewer-count priorities, a mechanism to hold on to occupied slots so they wouldn't flap under sudden interest, buffers between switchovers. All of this existed to work around a bottleneck on our IP, and the bottleneck is gone. What remains is a short simple loop: the server refreshes the database once every 30 seconds for active rounds (so a new viewer sees an up-to-date snapshot on first load), and the actual watching happens straight from the source.

Less code means fewer places for things to break.

## What you need to do

Nothing. The change is already in production. Open [any broadcast](/broadcasts) — this is how it works now.
