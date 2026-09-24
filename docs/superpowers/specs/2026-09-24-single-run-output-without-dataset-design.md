# Single Template Run output without an automatic Dataset

## Decision

A `single` Template Run creates a Run record and persists its producer output, but does not create a Dataset unless the caller explicitly supplies `output.dataset` with `create` or `dataset_id`. An `orchestrated` Run keeps its existing automatic Dataset default. Existing Runs and Datasets retain their current links and data.

## API and storage

- `POST /v1/template/{ref}/runs` passes an omitted `output.dataset` through unchanged for `single` Runs. Explicit New and Existing destinations continue through the existing Dataset Writer and schema/owner checks.
- `GET /v1/template/{ref}/runs/{run_id}/output` returns a bounded, paginated read of the Run's persisted successful `job_results`. It checks the Run owner and template association before looking up its backing job. It does not create or mutate a Dataset.
- The endpoint returns `items` shaped for the existing Run result viewer (`itemKey`, `sourceUrl`, `document`, timestamps), plus `nextCursor`. An in-progress Run may return an empty page; a completed Run without rows shows an empty result state. Failed Run errors remain on the Run record.
- The current `jobs` and `job_results` tables hold producer output; no new storage table or migration is needed. Existing job-result data is not backfilled into Datasets.

## Dashboard

- A `single` Store template opens with **Save to Dataset: None**. The other choices are **Existing** and **New**. The request preview includes `output.dataset` only for an explicit destination.
- An `orchestrated` Store template retains its automatic Dataset choice.
- The Run Output tab reads the Dataset Run when attached, otherwise the new Run output endpoint. Dataset links and exports appear only when a Dataset exists. The Dataset tab clearly says when none was requested.

## Verification

- API tests cover default omission, explicit Dataset destinations, owner isolation, pagination, and output after completion.
- Dashboard tests cover the single/orchestrated default request bodies and Run output rendering.
- Production E2E covers a single Run without Dataset, a Run with an explicit destination, the results page, Run history, and unchanged orchestrated behavior where a suitable template is available.

## Compatibility

`/execute` and direct scrape/search/crawl Dataset behavior remain unchanged. Existing Runs created under the earlier automatic Dataset default continue to display through their Dataset links. The prior design statement that all asynchronous Runs default to a Dataset is narrowed to `orchestrated` Runs.
