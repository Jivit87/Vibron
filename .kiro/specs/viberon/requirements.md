# Requirements Document

## Introduction

Viberon is a hackathon MVP web application that turns any public GitHub TypeScript or JavaScript repository into an interactive, force-directed bubble graph and a chat interface that answers questions about the codebase. When a user pastes a GitHub URL, Viberon downloads the repository tarball, parses TS/JS/TSX/JSX files with Babel, builds a graph of functions and classes connected by import and call edges, and persists the graph in Vercel KV / Upstash Redis. The user can then explore the graph visually and ask natural-language questions; Viberon uses graph-aware retrieval (BFS depth 2 plus TF-IDF keyword scoring) to select at most 30 relevant nodes and stream a Groq Llama 3.3 70B answer using only those nodes as context. A token-savings counter compares the selected-context size against a naive full-file dump, and the corresponding bubbles pulse in the visualization to make retrieval visible. The product is scoped for a 48-hour hackathon: read-only, no auth, TS/JS only, repos up to ~500 files, with 2-3 pre-warmed demo repos for judges.

## Glossary

- **Viberon**: The web application defined by this document.
- **Ingestion_Service**: The server-side component that downloads a GitHub repository tarball, extracts files, and orchestrates parsing.
- **Parser**: The server-side component that runs `@babel/parser` and `@babel/traverse` over TS/JS/TSX/JSX files to produce nodes and edges.
- **Graph_Store**: The Vercel KV / Upstash Redis backing store keyed by `sha1(owner/repo@ref)`.
- **Graph_Renderer**: The client-side `react-force-graph-2d` component that renders bubbles and edges.
- **Retrieval_Engine**: The server-side component that selects relevant nodes for a chat query using BFS depth 2 plus TF-IDF keyword scoring on node names and JSDoc.
- **Chat_Service**: The server-side component that calls the Groq SDK with the selected node context and streams responses.
- **Token_Counter**: The UI element that displays selected-context token count versus a baseline full-file-dump token count.
- **Job**: A repository ingestion task identified by a `jobId`, with a status of `queued`, `running`, `succeeded`, or `failed`.
- **Node**: A graph entry of kind `function` or `class` with fields `{ id, kind, name, file, folder, loc, signature, snippet, startLine, endLine }`.
- **Edge**: A directed graph connection of kind `import` or `call` with fields `{ source, target, kind }`.
- **Demo_Repo**: A pre-ingested repository whose graph already exists in Graph_Store and is selectable from the landing page.
- **Repo_Ref**: The string `owner/repo@ref` where `ref` defaults to the repository's default branch when not supplied.
- **Landing_Page**: The public marketing and entry page that explains Viberon and provides repo input plus demo selection.

## Requirements

### Requirement 1: Repository Ingestion

**User Story:** As a developer, I want to paste a public GitHub repository URL and have Viberon ingest it asynchronously, so that I can watch progress without blocking on a long request.

#### Acceptance Criteria

1. WHEN a user submits a public GitHub repository URL to `POST /api/repos`, THE Ingestion_Service SHALL return a JSON body containing a `jobId` and HTTP status 202.
2. WHEN a `jobId` is created, THE Ingestion_Service SHALL persist a Job record in Graph_Store with status `queued` and the derived Repo_Ref.
3. WHEN the client calls `GET /api/repos/:jobId/status`, THE Ingestion_Service SHALL return the current status (`queued`, `running`, `succeeded`, or `failed`), a numeric `progress` value between 0 and 100, and, when status is `succeeded`, the final graph payload.
4. WHEN ingestion begins for a Repo_Ref, THE Ingestion_Service SHALL download the repository as a tarball from GitHub.
5. IF the submitted URL is not a syntactically valid public GitHub repository URL, THEN THE Ingestion_Service SHALL return HTTP status 400 with an error message identifying the invalid URL.
6. IF the GitHub tarball download fails or returns a non-2xx status, THEN THE Ingestion_Service SHALL set the Job status to `failed` and record an error message retrievable via `GET /api/repos/:jobId/status`.
7. IF the repository contains more than 500 source files after filtering to TS/JS/TSX/JSX, THEN THE Ingestion_Service SHALL set the Job status to `failed` with an error message stating the 500-file cap.
8. WHEN a Repo_Ref's graph already exists in Graph_Store, THE Ingestion_Service SHALL return a `jobId` whose status resolves to `succeeded` without re-downloading or re-parsing the repository.

### Requirement 2: Code Parsing and Graph Construction

**User Story:** As a developer, I want each function and class in the repository represented as a graph node with import and call edges, so that the visualization reflects real code structure.

#### Acceptance Criteria

1. WHEN the Parser processes a source file, THE Parser SHALL only parse files with extensions `.ts`, `.tsx`, `.js`, or `.jsx`.
2. WHEN the Parser encounters a function declaration, function expression assigned to a named binding, arrow function assigned to a named binding, or class declaration, THE Parser SHALL emit a Node with `kind` set to `function` or `class` and fields `id`, `name`, `file`, `folder`, `loc`, `signature`, `snippet`, `startLine`, and `endLine` populated.
3. WHEN the Parser encounters an `import` statement in a file, THE Parser SHALL emit `import` Edges from every Node contained in the importing file to every Node contained in the resolved imported file, when the imported file is part of the parsed repository.
4. WHEN the Parser encounters a call expression whose callee resolves to a known Node, THE Parser SHALL emit a `call` Edge from the enclosing Node to the called Node.
5. THE Parser SHALL assign each Node a stable `id` derived from `file` plus `name` plus `startLine` so that the same source produces the same `id` across runs.
6. THE Parser SHALL set each Node's `folder` field to the top-level folder segment of `file` relative to the repository root.
7. THE Parser SHALL set each Node's `snippet` field to the source text between `startLine` and `endLine` truncated to at most 2000 characters.
8. IF a source file fails to parse, THEN THE Parser SHALL skip the file, record the failure in the Job's error log, and continue parsing remaining files.
9. WHEN parsing completes for a Repo_Ref, THE Ingestion_Service SHALL store the resulting `{ nodes, edges }` payload in Graph_Store keyed by `sha1(owner/repo@ref)`.

### Requirement 3: Bubble Graph Visualization

**User Story:** As a developer, I want to see the codebase as a force-directed bubble graph sized by LOC and colored by folder, so that I can visually grasp the shape of the project.

#### Acceptance Criteria

1. WHEN a Job reaches status `succeeded`, THE Graph_Renderer SHALL render the returned graph using `react-force-graph-2d` within the chat workspace view.
2. THE Graph_Renderer SHALL size each bubble proportional to the Node's `loc` field.
3. THE Graph_Renderer SHALL assign each bubble a color derived from the Node's `folder` field, where Nodes sharing a folder share a color.
4. WHEN a graph contains more than 500 Nodes, THE Graph_Renderer SHALL fully render the 500 Nodes with the highest combined in-degree plus out-degree and SHALL render the remaining Nodes at reduced opacity.
5. WHEN a user hovers a bubble, THE Graph_Renderer SHALL highlight that bubble and every Node connected by exactly one edge.
6. WHEN a user clicks a bubble, THE Graph_Renderer SHALL open a side panel displaying the Node's `file`, `signature`, and `snippet`.
7. WHEN the Retrieval_Engine returns selected Node ids for a chat query, THE Graph_Renderer SHALL apply a pulse animation to those bubbles for at least 2 seconds.

### Requirement 4: Graph-Aware Retrieval

**User Story:** As a developer, I want the AI to retrieve only the most relevant nodes for my question, so that answers are grounded and token usage stays low.

#### Acceptance Criteria

1. WHEN a chat query is submitted for a Repo_Ref, THE Retrieval_Engine SHALL score every Node in the graph using TF-IDF over the Node's `name` and JSDoc content against the query tokens.
2. WHEN scoring completes, THE Retrieval_Engine SHALL select the highest-scoring Nodes as seeds and expand selection by breadth-first search of depth 2 over `import` and `call` Edges.
3. THE Retrieval_Engine SHALL cap the final selected Node set at 30 Nodes, retaining the highest-scoring Nodes when the BFS expansion exceeds the cap.
4. WHEN selection completes, THE Retrieval_Engine SHALL return the selected Node ids and a context payload containing each selected Node's `name`, `signature`, and `snippet` truncated to fit within the cap.
5. IF the graph for the Repo_Ref is empty, THEN THE Retrieval_Engine SHALL return an empty selection and the Chat_Service SHALL respond with a message stating that no code context is available.

### Requirement 5: Chat with Groq LLM

**User Story:** As a developer, I want to chat with my codebase and receive streaming answers, so that exploration feels conversational.

#### Acceptance Criteria

1. WHEN a user submits a chat message for a Repo_Ref, THE Chat_Service SHALL invoke the Groq SDK with model `llama-3.3-70b-versatile` and the Retrieval_Engine context payload.
2. WHEN the Groq SDK returns a streamed response, THE Chat_Service SHALL stream tokens to the client as they are received.
3. THE Chat_Service SHALL include in every prompt only the selected Node context returned by the Retrieval_Engine and SHALL NOT include unselected Nodes.
4. WHEN a chat response completes, THE Chat_Service SHALL return the selected Node ids alongside the response so the Graph_Renderer can pulse the corresponding bubbles.
5. IF the Groq API call fails, THEN THE Chat_Service SHALL return an error message to the client identifying the failure and SHALL NOT crash the page.
6. THE Chat_Service SHALL not persist chat history across page reloads.

### Requirement 6: Token Savings Counter

**User Story:** As a developer, I want to see how many tokens graph-aware retrieval saves versus a naive full-file dump, so that I can quantify the system's value.

#### Acceptance Criteria

1. WHEN the Retrieval_Engine produces a context payload, THE Chat_Service SHALL compute the token count of that payload and a baseline token count equal to the concatenated content of every file referenced by any selected Node.
2. WHEN a chat response is returned to the client, THE Token_Counter SHALL display the selected-context token count, the baseline token count, and the difference as a savings value.
3. THE Token_Counter SHALL update its displayed values for every chat query within the same session.

### Requirement 7: Demo Repositories and Landing Page

**User Story:** As a hackathon judge, I want to land on a polished page that lets me try the product without signup, so that I can evaluate it in under a minute.

#### Acceptance Criteria

1. THE Landing_Page SHALL render in dark mode using Tailwind plus shadcn/ui components.
2. THE Landing_Page SHALL display 2 to 3 Demo_Repo entries whose graphs are pre-warmed in Graph_Store.
3. WHEN a user clicks a Demo_Repo entry, THE Viberon application SHALL navigate to the chat workspace and load the pre-warmed graph without re-parsing.
4. THE Landing_Page SHALL provide a text input that accepts a GitHub repository URL and submits it to `POST /api/repos`.
5. THE Landing_Page SHALL display at least one pre-canned demo question per Demo_Repo that, when clicked, submits as a chat query.
6. THE Viberon application SHALL not require user accounts, sign-in, or authentication for any user-facing flow described in this document.

### Requirement 8: Performance and Scope Boundaries

**User Story:** As a hackathon team, I want explicit scope limits encoded in the requirements, so that the build stays achievable in 48 hours.

#### Acceptance Criteria

1. WHEN a repository contains at most 500 TS/JS/TSX/JSX source files, THE Ingestion_Service SHALL complete ingestion within 60 seconds on the production deployment for the Demo_Repo set.
2. THE Viberon application SHALL only support source files with extensions `.ts`, `.tsx`, `.js`, and `.jsx`.
3. THE Viberon application SHALL operate as a read-only tool and SHALL NOT expose any endpoint that modifies repository source code.
4. THE Viberon application SHALL NOT use vector embeddings or external vector databases for retrieval.
5. WHERE the Vercel KV / Upstash Redis credentials are configured, THE Graph_Store SHALL use that backing service for all persistence.
