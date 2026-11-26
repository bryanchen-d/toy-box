## 📅 Unreleased

- Toy Box is now Agent Teams, and channels are now teams
- The app icon is now a squad of robots: a yellow lead and its cyan crew, looking ahead together on a transparent background that suits light and dark desktops
- Teams lead the sidebar, followed by a collapsible Sessions section that holds the session filter
- The browser title names the team in focus, and so does an installed app's window title
- Installed apps can toggle a team's panels with Ctrl+Shift on Windows/Linux or Cmd+Shift on Mac: T for Tasks, M for Members, P for Performance, S for Security, C for Canvas, A for Artifacts, O for Overview, and R for Routines. They work while typing in the team's chat and from anywhere outside other text fields, addressing the team you last used. Tooltips show the shortcuts; browser tabs and other editors keep their own keyboard behavior
- The desktop layout runs edge to edge: square views divided by thin rules, with no margin to the window's border
- The sidebar's top row is now an Inbox button in place of the app's name, which the browser tab or app title bar already shows; teams are created from the Teams section and sessions, documents, and whiteboards from the Sessions section
- Connectors link outside services, like a Slack bot, that any team can message by starting with its @handle, over a URL or a private dev tunnel
- Content written by others (web pages, GitHub issues, MCP results, and other people's Slack messages) is marked as untrusted wherever agents read it and screened for prompt injections. The Security toggle on each Team's panel bar records each attack, quoting the passage and saying why it's risky, and answers questions about it; until you close it as not an attack or a real attack, that session needs your approval, or is blocked in background work, to send data out, read credentials, delete work, or change agent instructions. Warn agent tells the session not to act on the content, and closed findings load page by page under Closed, where they can be reopened. Screening knows which parts of an agent's command output came from others, double-checks each flag with a stronger model, and learns from the flags you close as not attacks
- A team's work is tasks. The lead opens each one (numbered like t12) and assigns it to one agent, which works on it in the task's own thread and reports on it at the end of every turn. An assignee closes its finished task as completed, which tells the lead to double-check it, and hands a task off to the lead for any other close, like cancelling, which the lead closes with a status or sends back. Hover a task for its card, with what it's for, who's on it, and when and by whom it last changed; choose it to open its thread. Assignees can ask you questions in their task's thread, one per thread, which the Tasks panel lists under Needs your input; the lead gathers them into one question and passes your answers along. The lead is woken once for every close, hand-off, and question it hasn't read, rather than for each change. A task without a thread yet shows the latest message that mentions it as soon as you open it, and the lead revisits any open task nobody has touched in three days, unless it's waiting on your answer
- A team's lead marks a question it flagged for you as answered once it gets the answer another way, such as from a member, a connector, or another team: the question shows a gray check and Answered, and the team stops waiting on your reply
- The Admin team tells you when a session stops responding: if a session waits 15 minutes on its model with no tool, question, or background work running, Admin posts which session it is and how many messages haven't reached it, and its lead asks you to stop it and message it again. Click the session's name to open it
- Ctrl/Cmd-clicking a link in a Markdown artifact opens the artifact or file it names, whether a `file:///` URI, like one to another session's artifact, or a path relative to the artifact. Copy artifact URI in a team's Artifacts panel, or the link button on any open file, copies that `file:///` URI to share or reference

## 📅 v0.3.1 (10/20/26)

- The session composer now shows a context meter when the context window is >50% used
- Session providers now display your plan and usage in the settings dialog
- Sessions/channel members now have the notion of "backgrounded"

## 📅 v0.3.0 (10/13/26)

- Added support for desktop/screen sharing
- Copilot and Codex sessions/channels now support image generation (Claude doesn't)
- You can now @mention sessions from a session
- Child sessions now appear in the sidebar
- The channel checklist now displays associated diffs and artifacts for items
- Channel attachments now support videos (in addition to images)
- Channels can now be filtered to just your messages
- Channels and the inbox now persist/sync draft messages

## 📅 v0.2.0 (09/22/26)

- Introduced support for Codex and Claude-based sessions
- Re-designed the session composer
- Added an overview pane/sheet to channels
- SVG/whiteboard files now support pinch-to-zoom
- Added new tools for sessions/agents to search and read sessions
- Added a customized "ink cloud" to the channel and inbox panes

## 📅 v0.1.20 (09/08/26)

- Introduced the notion of agents and channels
- Added an "ink cloud" to draft sessions and an ink-splatter typing effect to the session composer
- The skill picker and skill tool call now allow opening the `SKILL.md` directly in an editor pane
- Artifact pills in a session now show when a file has active workers running
- _(Engineering)_ Migrate shared interface primitives from Radix UI to Base UI

## 📅 v0.1.19 (08/26/26)

- Add support for configuring the context window
- The artifacts list is now scoped to common file types

## 📅 v0.1.18 (08/21/26)

- Introduced the concept of "intent board" artifacts
- Added support for user input questions
- Qeueued messages can now be sent immediately ("steering")

## 📅 v0.1.17 (08/14/26)

- Added support for session-scoped apps (`.toy` artifacts)
- Queued messages now display attachments

## 📅 v0.1.16 (08/06/26)

- The sidebar can now be collapsed while retaining access to common actions

## 📅 v0.1.15 (08/05/26)

- Added initial support for custom apps

## 📅 v0.1.14 (07/21/26)

- Introduce support for "hyper sessions"
- Draft prompt values are no synced with the server
- Added inbox + chrome extension to send async tasks to it
- Allow sending queued mesages immediately by long-pressing them

## 📅 v0.1.13 (07/02/26)

- Add initial support for artifact panes (markdown and HTML)

## 📅 v0.1.12 (06/21/26)

- Add initial support for canvas panes
- Fixed misc. bugs related to tool calls/automaations

## 📅 v0.1.11 (06/12/26)

- Added support for GPT-based edit tool calls

## 📅 v0.1.10 (06/10/26)

- Introduced agent tools for creating and editing automations
- Added support for configuring reasoning effort
