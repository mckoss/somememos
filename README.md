# somememos

A second brain made of plain markdown files, with a sidecar database that adds keyword search and time-aware working memory.

somememos ranks your notes by what you're working on now, what's heating up, and what you've let go quiet. It uses the [TimeScore](https://mckoss.com/posts/timescore/) algorithm: every bit of activity adds to a note's score, and scores fade with a half-life at several time scales (a day, a week, a month, a year).

- **Your notes stay plain markdown.** The sidecar can always be exported alongside them.
- **Offline first.** The CLI and web clients work on a local copy and sync to the server.
- **Built for agents.** An MCP server lets any AI agent search, read and write your brain.

Status: planning. See [PLAN.md](PLAN.md).

The name is a palindrome: *somememos* reads the same forwards and backwards, like a memory that looks both back at what you've done and ahead at what's coming.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
