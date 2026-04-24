# Vector Embeddings and RAG — Core Concepts

This document explains the foundational ideas behind this project for readers who are new to vector search and retrieval-augmented generation. If you already know what embeddings are and why chunking matters, you can skip straight to the [Ingestion Pipeline](../ingestion-pipeline.md).

---

## What is an embedding?

An **embedding** is a list of numbers that represents the meaning of a piece of text. Given the sentence "How do I clean the filter?", an embedding model converts it into something like `[0.021, -0.48, 0.93, ...]` — a vector with hundreds or thousands of numbers.

The key property: **texts with similar meaning produce vectors that point in similar directions**. "How do I wash the filter?" and "How do I clean the filter?" will have vectors that are very close together, even though the words are different. "What is the capital of France?" will produce a vector that points in a completely different direction.

This is what makes embeddings useful for search: instead of matching keywords, you match _meaning_.

In this project, the embedding model is OpenAI `text-embedding-3-small`, which produces vectors with **1536 dimensions** — meaning each piece of text becomes a list of 1536 numbers.

---

## What is a vector database?

A **vector database** stores embeddings and can efficiently find the ones that are closest to a query embedding. "Closest" is measured using **cosine similarity** — a mathematical way of measuring the angle between two vectors. Vectors pointing in nearly the same direction have high cosine similarity (close to 1.0); vectors pointing in opposite directions have low similarity (close to -1.0).

When a shopper asks a question:

1. The question is converted to an embedding.
2. The vector database finds the stored embeddings (document chunks) whose vectors are closest to the question's vector.
3. Those closest chunks are returned as the most relevant context.

This is fundamentally different from keyword search (like a SQL `LIKE` query), which can only match exact words. Vector search matches by meaning, so "how do I empty the dustbin" can retrieve a chunk titled "Emptying the Dust Container" even though none of the words match.

This project uses **MongoDB Atlas Vector Search** as the vector database, which means vectors and regular document data live in the same database — no need to manage a separate vector store alongside your main database.

---

## What is chunking?

You can't embed an entire 200-page product manual as one vector. A single embedding can only capture the gist of a piece of text — the longer the text, the more detail gets averaged away. If you embed the whole manual as one vector, a query about "filter cleaning" will match the manual in general but can't point you to the specific section that answers the question.

**Chunking** is the process of splitting a document into smaller pieces before embedding each piece individually. Each chunk gets its own vector. When a question comes in, you retrieve the specific chunks that are relevant, not the whole document.

Chunk size involves a tradeoff:

- **Too large** — each chunk covers too many topics, so a single chunk might be retrieved for the wrong reason (the question matches one paragraph but the chunk also contains irrelevant content).
- **Too small** — each chunk loses context. A sentence like "Turn the dial clockwise" doesn't tell you what the dial does or what you're setting up.

This project chunks at **512 tokens** (roughly 2000 characters of English prose) with **50-token overlap** between adjacent chunks. The overlap ensures that a sentence at the boundary between two chunks isn't lost — it appears in both.

Sizing is done in **tokens** rather than characters because character counts behave unpredictably for tables, code, and non-Latin scripts. Tokens are more consistent units of "how much text the model sees."

---

## What is RAG?

**RAG (Retrieval-Augmented Generation)** is the pattern of combining a search step with an LLM generation step to produce answers that are grounded in specific source documents rather than the model's training data.

The flow:

1. **Retrieve** — use vector search to find the document chunks most relevant to the user's question.
2. **Augment** — include those chunks in the prompt to the LLM, as context.
3. **Generate** — the LLM answers the question using the retrieved context, not just its training data.

Without RAG, a model answering "How do I clean the Dreame X40 Ultra filter?" is relying on whatever it learned during training — which may be outdated, incomplete, or hallucinated. With RAG, the model is given the actual relevant sections of the Dreame X40 Ultra manual before it generates a response, so it can cite specifics.

RAG is why the chat widget in this project can answer precise product questions accurately: the retrieval step ensures the model sees the right source material before it speaks.

---

## What is contextual retrieval?

A limitation of basic chunking: chunks lose context when they're split from the document. A chunk might say "Turn the brush roll switch to the OFF position" — but without knowing which section of the manual that came from, it's not clear whether this is about maintenance, storage, or a safety warning.

**Contextual retrieval** (introduced by Anthropic in 2024) addresses this by prepending a short summary to each chunk before embedding it. For example:

> _This chunk is from the Maintenance section of the Dreame X40 Ultra manual and describes how to disable the brush roll before cleaning it._
> Turn the brush roll switch to the OFF position...

The summary — called a **context header** — is generated by an LLM that sees the whole document and writes one or two sentences situating the chunk within it. The header is prepended to the chunk text only for the purpose of creating the embedding; the runtime LLM still reads just the raw chunk body.

The result: the embedding captures where the chunk fits in the document, not just what it literally says. Anthropic's benchmark showed a ~35% reduction in retrieval failures using this technique.

---

## What is an eval, and why does it gate the pipeline?

An **eval** (evaluation) is a test that measures whether a system is doing its job correctly. In this project, the eval measures retrieval quality: given a question, do the retrieved chunks actually contain the information needed to answer it?

The eval uses a **golden set** — 25 question/answer pairs generated from the product manual. "Golden" means these pairs are fixed and reused across every run, so score changes reflect real changes in retrieval quality rather than randomness in the test itself.

For each question, the eval runs three LLM-as-judge scores aligned to the three retrieval metrics defined by [RAGAS](https://docs.ragas.io/en/stable/) (Retrieval-Augmented Generation Assessment), an open-source RAG eval framework:

- **Faithfulness** — are the retrieved chunks actually relevant to the question?
- **Context recall** — does at least one retrieved chunk contain each key claim from the expected answer?
- **Context precision** — are the most useful chunks ranked first, or buried?

The pipeline is **eval-gated**: after ingesting new data, the eval runs automatically, and the results tell you whether the chunk quality is good enough to serve queries. This prevents a bad ingestion run (wrong chunk size, broken contextualization, etc.) from silently degrading the chat widget.

---

## Where to go next

- [Ingestion Pipeline](../ingestion-pipeline.md) — detailed walkthrough of every step from PDF to vector store
- [Glossary](../../README.md#glossary) — quick definitions for every acronym used in this project
- [Key technical choices](../../README.md#key-technical-choices) — the rationale behind specific decisions (embedding model, chunk size, MongoDB over Pinecone, etc.)
