# Build notes

## 1. The layout broke with real model output

After I designed the finished report view, I connected the interface to the real model output abut the finished investigation UI started breaking. Data labels did not have enough room, long and repeated text pushed information further down the view, and the evidence section I had in accordions became difficult to navigate, and so on.

The fix involved both the model output and the interface. For the model output, I added rules that keep each field focused and legible. If the output ignores the rules, the model gets a validation error message and rewrites the report. On the interface side, I adjusted distribution, spacing, typography and density until it felt balanced, legible and easy to scan. I also introduced the side menu for moving through the evidence.

## 2. The model knew the answer but could failed to fill out the report

Sonnet could find the correct cause and still fail at the last step. The investigation was right, but the final report could be rejected because it missed a required field or ignored a limit. When that happened, the next attempt did not know what was wrong and could repeat the same mistake.

I changed the retry so the model sees the rejected report and the exact error. It can correct the report and try again, but only within a limited number of attempts.

## 3. A failed investigation could still look active

The first live I had assumed progress will would arrive steadily. But after a fatal failure or an interrupted worker, the run could still contain an active plan step, so the page could look like the agent was working when it had actually stopped.

Imade the saved investigation record the source of truth instead of just running + an active plan step, so unfinished plan steps stop when the run ends, and a silent runs either resume from its checkpoint or its marked failed after a timeout.

## 4. The finished investigation outgrew the small artifact

At first, it was challenging to picture the product, so I started by designing the finished investigation as a small artifact. In that format, the information needed cards, accordions and more clicks and transitions to navigate it.

But when I was thinking where would this component live in the larger product shell, that pattern no longer made sense. I changed it into a document-style page and iterated on how someone would move through the information: scroll to read the main story, then click to dig into evidence and receipts.
