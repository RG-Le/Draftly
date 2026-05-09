# Draftly - One Pager

**Selected Topic:** Draftly – Gmail AI Reply Agent

## Objective
Draftly addresses the operational overhead of routine professional communications. By automating email confirmations and follow-ups, the system improves productivity while ensuring stylistic consistency. The objective is to build a reliable, extensible Gmail AI agent that fetches incoming emails, generates high-context drafts, learns user style, and provides a strict review-before-send workflow.

## Step-by-Step Approach

**1. Secure Integration & Data Ingestion**
*   **OAuth2 Authorization:** Implement a secure OAuth2 flow for users to authenticate and connect their Gmail accounts. Encrypt and store tokens securely using AES-256.
*   **Email Syncing:** Develop scheduled background workers to periodically fetch incoming emails and their metadata (Sender, Subject, Thread ID) via the Gmail API, strictly adhering to rate limits and quotas.

**2. Intelligent Triage & Contextual Profiling**
*   **Triage Pipeline:** Process incoming threads through an AI classifier to evaluate urgency and determine if a reply is needed (`reply_needed`).
*   **Persona Learning:** Analyze the user’s recently sent emails to build a personalized communication profile, capturing their preferred tone, greeting, and closing styles.

**3. Automated Draft Generation**
*   **Asynchronous Processing:** Utilize a robust message broker (e.g., Redis + BullMQ/Celery) to orchestrate draft generation without blocking the main API thread.
*   **LLM Integration:** Feed the thread history and the user's learned persona into a Large Language Model (LLM) to generate highly contextual, stylized, and accurate reply drafts.

**4. Review, Approval & State Management**
*   **API Layer:** Expose RESTful APIs for the frontend to retrieve threads, triage statuses, and the generated drafts.
*   **Workflow States:** Implement a strict state machine for drafts (Generated → Edited → Approved / Rejected). This ensures an "Approved-only" dispatch logic, preventing rogue automated emails.

**5. Native Synchronization & Reliable Dispatch**
*   **Gmail Draft Sync:** Automatically mirror the AI-generated drafts to the user's actual Gmail "Drafts" folder for seamless cross-platform accessibility.
*   **Thread Integrity:** Upon user approval, dispatch the email via the Gmail API, carefully injecting `In-Reply-To` and `References` headers to maintain native email threading.
*   **Failure Handling:** Implement idempotency keys for the sending logic and automatic retry mechanisms for network or token expiration failures.

**6. Persistence & Security**
*   **Database:** Use a relational database (PostgreSQL) to persist user profiles, email metadata, draft states, and historical logs.
*   **Security Guardrails:** Enforce strict access control (Auth/Authz) on all endpoints and encrypt sensitive user preferences to guarantee data privacy.
