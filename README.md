# somememos

A second brain made of plain markdown files, with a sidecar database that adds keyword search and time-aware working memory.

somememos ranks your notes by what you're working on now, what's heating up, and what you've let go quiet. It uses the [TimeScore](https://mckoss.com/posts/timescore/) algorithm: every bit of activity adds to a note's score, and scores fade with a half-life at several time scales (a day, a week, a month, a year).

- **Your notes stay plain markdown.** The sidecar can always be exported alongside them.
- **Works offline where it matters.** The web app keeps a local copy and syncs to the server. Agents use a command-line tool that talks to the server and fetches only what they read.
- **Built for agents.** A command-line tool lets any AI agent with a shell search and read your brain. An MCP server follows for agents without one.

Status: planning. See [PLAN.md](PLAN.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md).

The name is a palindrome: *somememos* reads the same forwards and backwards, like a memory that looks both back at what you've done and ahead at what's coming.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
