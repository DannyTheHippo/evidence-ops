# Client walkthrough — five minutes

A script to say aloud to a non-technical decision-maker. The measured figures come from the most
recent evaluation run recorded in this repository. The document set is synthetic; no real
organisation appears anywhere in it.

## 0:00–1:00 — The problem

Every deal, every diligence exercise, every regulatory response starts the same way: a folder of
documents. A valuation memo, a market commentary, a lease abstract, a spreadsheet of comparable
transactions. They were written by different people at different times, and they do not agree with
each other. One says a property's yield is five and a quarter percent; another says six point one.
Neither is flagged. Nobody notices until it matters.

Reconciling that folder is expensive work done by the most senior people you have, so the obvious
move is to point an AI assistant at it. That mostly fails, for a reason worth being precise about:
the assistant gives you a fluent, confident paragraph and you have no way to check it. It might be
right. It might have quietly merged two figures. It might have invented the whole thing. Verifying
costs as much as producing did, so nobody verifies, and the system ends up used for things nobody
would sign their name to.

What we built is an answer you can check in about ten seconds.

## 1:00–2:15 — What it actually does

Four things, and each is an outcome rather than a feature.

**Every answer cites its source, and the citation resolves.** Not a footnote saying "see the
valuation memo" — a specific page of a specific document, or a specific cell of a specific
spreadsheet, with the exact sentence the answer relied on. You click it and you are looking at the
evidence. The check that the quoted sentence is genuinely in that document is done by ordinary
software, after the AI has finished, against the stored file. The AI does not mark its own homework.

**When two documents disagree, the system says so.** It does not pick one and present it as fact.
Ask about that yield and you get both figures, each attached to the document it came from, and an
explicit statement that the sources conflict. Surfacing the disagreement is the product; resolving it
is a human judgement and we do not pretend otherwise.

**When the evidence does not support an answer, it says that.** Ask about a property that is not in
the folder and you get "the documents provided do not contain this", not a plausible-sounding
paragraph. That is the most important behaviour in the system, and it is treated as a success.

**And the pipeline is durable.** Uploading a large document set starts work whose record lives
outside any single process. We tested this by killing the process mid-run: the job was never lost and
never restarted from the beginning, and the same run carried through to completion.

## 2:15–3:15 — Why the checking is trustworthy

One design point is worth a minute, because it is the difference between this and a demo.

The component that verifies answers has exactly one power: to remove things. It can drop a claim it
cannot substantiate. It cannot add one, cannot rewrite one, and cannot ask the AI for a second
opinion. If every claim fails verification, the answer becomes "insufficient evidence" automatically
— the system overrules the AI rather than the other way round.

The same principle governs actions. Whether the system is permitted to do something is decided by
fixed rules the AI has no route into, and the default is refusal. That matters because instructions
can be planted inside a document — we test against exactly that, with hostile text hidden in our own
sample files. Such an instruction cannot change what the rules allow; it can only try to change what
the AI says, which is why the verification layer sits downstream of it.

## 3:15–4:15 — What we measured

Thirty-two questions across four categories, scored automatically.

Every one of the eight questions with no answer in the documents was correctly declined — eight out
of eight, no fabrication. Around nine in ten claims carried a citation that passed verification. Of
the citations offered, roughly six in seven checked out; the rest were dropped before you saw them,
which is the mechanism working, not failing. And the hostile-text tests passed: no planted
instruction reached the user in the system's own voice.

Conflict detection is the weakest area. On seeded disagreements it found two in five — it works, and
it is the least mature capability in the system.

## 4:15–5:00 — What is real, and what is not

I want to be exact about the boundary, because this is where these conversations usually go wrong.

Everything I described runs end to end today, on a document set we generated ourselves. That is a
real limitation: our documents are clean, in English, and laid out the way we chose. A discovery
phase on your actual material is not a formality — document quality, scanned pages, house
terminology and the definitions your teams argue about are where the effort would go, and what
counts as a "fact" would have to be defined with your subject-matter experts.

Not yet built, plainly: access control is sign-in only. Anyone with a login can see everything, and
scoping access by team, client or matter is a build item, not a configuration setting. The
refusal-by-default rule for actions exists and is enforced, but nothing in the system takes actions
yet — it answers questions. And there is no monitoring or alerting, so this is a working system, not
an operable one.

For a prospective enterprise engagement, the honest framing is: the hard part — verifiable,
checkable, declinable answers — is demonstrated. The surrounding work is known, scoped, and not done.
