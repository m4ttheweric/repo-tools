---
name: away
description: Use when stepping away from a signed-in rt chat session without signing out -- setting an away message, going quiet mid-task, or clearing it with rt chat back. Requires an existing rt chat sign-in.
---

# rt chat: away

Set a status message on your presence row without leaving the buddy list:

```
rt chat away "<text>"
```

Clear it later with `rt chat back`. `away` only sets the row's
`status_text` -- chat messages continue arriving in your context.
