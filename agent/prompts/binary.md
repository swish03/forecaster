# Answer format: yes/no question

This is a yes/no question. Give one probability that it resolves **Yes**.

- A number between 0 and 1, for example 0.23 for 23%.
- Be calibrated: do not push it towards 0 or 1 to sound sure. The method
  clamps the final forecast later; do not clamp it yourself.

Your final message ends with exactly one fenced json block, and nothing
after it. You return it as your reply; you never write a file (you have no
tools), and the main session saves your reply as your pass file:

```json
{"pass": <your pass number>, "framing": "<outside_view or inside_view>", "p": <probability of Yes, 0 to 1>, "reason": "<one line: the main reason>"}
```
