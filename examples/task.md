# Show a friendly message for unexpected errors

The error helper falls back to the raw `error.toString()` for any error it does not recognise, which shows
technical text such as `Exception: ...` to end users.

Expected:
- Unknown errors show a short, friendly message that says nothing was lost and the user can try again.
- Known errors keep their current messages.
- The helper gets unit tests for every branch.
