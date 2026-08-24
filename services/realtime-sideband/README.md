# BiteSites Realtime Sideband

This service owns the persistent server-side WebSocket for AI-controlled SIP calls. Firebase Functions remains the authoritative control plane for call ownership, prompt compilation, DNC, handoff state, transcripts, and auditing. The sideband service has no Firebase Admin credential and may act only through the `hybridSidebandControl` endpoint using `AI_MEDIA_WEBHOOK_SECRET`.

## Why this is a separate service

A live Realtime call can last many minutes and requires a persistent WebSocket for transcript and function-call events. It should not depend on the lifetime of a short HTTP Cloud Function invocation. Twilio carries the SIP leg, OpenAI carries realtime voice, Firebase owns durable state, and this service maintains the sideband WebSocket.

## Required environment variables

- `OPENAI_API_KEY` — server-only OpenAI API key.
- `OPENAI_WEBHOOK_SECRET` — signing secret for the OpenAI project webhook.
- `AI_MEDIA_WEBHOOK_SECRET` — same high-entropy value stored in Firebase Secret Manager.
- `FIREBASE_CONTROL_URL` — normally `https://bitesites.org/api/hybrid-sideband-control`.
- `PORT` — injected by Cloud Run; defaults to 8080.

Never use a browser-visible API key here.

## OpenAI webhook

Configure the OpenAI project webhook to send `realtime.call.incoming` events to:

`https://<sideband-service-domain>/openai/webhook`

The service verifies the webhook signature before reading the event. The SIP INVITE must include `X-BiteSites-Call-ID`; `dispatchHybridAIToSip` adds it automatically.

## Cloud Run deployment

Use a dedicated service and keep CPU allocated while the instance is alive, because outbound WebSocket sessions continue after the webhook HTTP response has completed.

Example deployment shape:

```bash
gcloud run deploy bitesites-realtime-sideband \
  --source services/realtime-sideband \
  --region us-central1 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --min 1 \
  --set-env-vars FIREBASE_CONTROL_URL=https://bitesites.org/api/hybrid-sideband-control \
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest,OPENAI_WEBHOOK_SECRET=OPENAI_WEBHOOK_SECRET:latest,AI_MEDIA_WEBHOOK_SECRET=AI_MEDIA_WEBHOOK_SECRET:latest
```

The public service is acceptable because `/openai/webhook` requires a valid OpenAI signature and the only other public route is `/health`. All Firebase mutations require the separate media secret.

## Runtime behavior

1. Firebase creates `aiMediaJobs/{callId}` when an overflow human answer needs AI.
2. `dispatchHybridAIToSip` creates one Twilio SIP call to the configured OpenAI project.
3. OpenAI sends `realtime.call.incoming` to this service.
4. The service verifies the webhook and asks Firebase for the already-compiled runtime.
5. The service accepts the Realtime call with only the tools implemented by this service.
6. The sideband WebSocket writes final prospect/AI transcripts to Firebase.
7. Explicit prospect requests invoke `request_human_handoff`.
8. Explicit opt-outs invoke `mark_do_not_call`.
9. For takeover, the service says the exact configured handoff phrase and waits for `output_audio_buffer.stopped` before telling Firebase the human may join.
10. Once Firebase reports human ownership, the OpenAI SIP leg is hung up and the prospect remains in the same Twilio conference with the rep.

## Failure behavior

- Duplicate Firestore delivery cannot create two SIP AI legs because the media job is transactionally claimed.
- If OpenAI configuration cannot be loaded, the incoming SIP leg is rejected instead of connecting a prospect to silence.
- If runtime compilation, SIP setup, Realtime acceptance, attachment acknowledgement, or the sideband WebSocket fails, Firebase immediately marks AI control terminal, hangs up the Realtime leg, and ends the prospect carrier leg. A durable one-minute reconciler retries incomplete teardown; a live prospect is never left waiting on a failed AI controller.
- Agent tools that are not implemented server-side are not exposed to the Realtime model, even if a future profile field asks for them.
