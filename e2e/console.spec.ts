// Two people, two browser contexts, one server. Each test uses its own
// incidents so the tests don't affect each other.

import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'

type Name = 'asha' | 'ravi' | 'guest'

async function signIn(browser: Browser, name: Name): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/')
  await page.getByRole('button', { name: `Continue as ${name}` }).click()
  await expect(page.getByText(`Signed in as ${name}`)).toBeVisible()
  return page
}

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/#${id}`)
  await expect(page.locator('.detail-id')).toContainText(id)
  await expect(page.getByTestId('live')).toHaveText('Live')
}

// Incident ids in a status, straight from the API (Connect speaks plain JSON over POST).
async function ids(request: APIRequestContext, status: 'TRIGGERED' | 'ACKNOWLEDGED'): Promise<string[]> {
  const r = await request.post('/ops.v1.IncidentService/ListIncidents', {
    headers: { authorization: 'Bearer demo-viewer', 'content-type': 'application/json' },
    data: { statuses: [`STATUS_${status}`], pageSize: 100 },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).incidents.map((i: { id: string }) => i.id)
}

// Cut a page's live updates. route() only affects new requests, so the page
// is reloaded: it comes back with fresh data but no stream.
async function cutStream(page: Page): Promise<void> {
  await page.context().route('**/ops.v1.IncidentService/WatchTimeline', (route) => route.abort())
  await page.reload()
  await expect(page.getByTestId('live')).toHaveText('Reconnecting...')
}

test('a viewer can read but not act', async ({ browser, request }) => {
  const [id] = await ids(request, 'TRIGGERED')
  const guest = await signIn(browser, 'guest')
  await open(guest, id)
  await expect(guest.getByText('read only')).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Acknowledge', exact: true })).toHaveCount(0)
  await expect(guest.getByLabel('Add a note')).toHaveCount(0)
})

test('filters and Load more', async ({ browser }) => {
  const asha = await signIn(browser, 'asha')
  await asha.getByLabel('Resolved').check()
  await expect(asha.locator('.count')).toHaveText('15 shown, more available') // not "(refreshing)"
  await asha.getByRole('button', { name: 'Load more' }).click()
  await expect(asha.locator('.count')).toHaveText('30 shown, more available')

  await asha.getByLabel('Severity').selectOption('1')
  await expect.poll(async () => new Set(await asha.locator('.row .sev').allInnerTexts())).toEqual(new Set(['SEV1']))
})

test("one responder's changes reach the other live, without a reload", async ({ browser, request }) => {
  const [id] = await ids(request, 'TRIGGERED')
  const asha = await signIn(browser, 'asha')
  const ravi = await signIn(browser, 'ravi')
  await open(asha, id)
  await open(ravi, id)

  await asha.getByRole('button', { name: 'Acknowledge', exact: true }).click()
  await asha.getByLabel('Add a note').fill('Rolled back deploy 4812')
  await asha.getByRole('button', { name: 'Post note' }).click()

  // Ravi did nothing: the stream brought the events, and the version on the
  // acknowledge event told his page its copy was stale.
  await expect(ravi.locator('.timeline')).toContainText('asha is on it')
  await expect(ravi.locator('.timeline')).toContainText('Rolled back deploy 4812')
  await expect(ravi.getByTestId('status')).toHaveText('Acknowledged')
  await expect(ravi.getByTestId('owner')).toHaveText('asha')
  await expect(ravi.getByRole('button', { name: 'Acknowledge', exact: true })).toHaveCount(0)
  await ravi.screenshot({ path: 'results/live-update-ravi.png' })
})

test('a stale write is refused, the old status comes back, and a retry works', async ({ browser, request }) => {
  const [id] = await ids(request, 'ACKNOWLEDGED')
  const asha = await signIn(browser, 'asha')
  const ravi = await signIn(browser, 'ravi')
  await open(asha, id)
  await open(ravi, id)
  // Ravi's live updates drop out, so his page will keep showing this version.
  await cutStream(ravi)
  const before = await ravi.getByTestId('version').innerText()
  await asha.getByRole('button', { name: 'Mark mitigated' }).click()
  await expect(asha.getByTestId('status')).toHaveText('Mitigated')
  await expect(ravi.getByTestId('version')).toHaveText(before)

  // Ravi resolves from his stale copy. The server refuses it (Aborted),
  // the optimistic "Resolved" is rolled back, and his view reloads.
  await ravi.getByRole('button', { name: 'Resolve', exact: true }).click()
  await expect(ravi.getByRole('alert')).toContainText('Someone else changed this incident')
  await expect(ravi.getByTestId('status')).toHaveText('Mitigated')
  await expect(ravi.getByTestId('version')).not.toHaveText(before)
  await ravi.screenshot({ path: 'results/conflict-ravi.png' })

  // Now that he sees the current version, the same click goes through.
  await ravi.getByRole('button', { name: 'Resolve', exact: true }).click()
  await expect(ravi.getByTestId('status')).toHaveText('Resolved')
  await expect(ravi.getByRole('alert')).toHaveCount(0)
})

test('a dropped stream reconnects and catches up on what it missed', async ({ browser, request }) => {
  const [, id] = await ids(request, 'TRIGGERED')
  const asha = await signIn(browser, 'asha')
  const ravi = await signIn(browser, 'ravi')
  await open(asha, id)
  await open(ravi, id)

  await cutStream(ravi)

  await asha.getByLabel('Add a note').fill('Posted while ravi was offline')
  await asha.getByRole('button', { name: 'Post note' }).click()
  await expect(ravi.locator('.timeline')).not.toContainText('Posted while ravi was offline')

  await ravi.context().unroute('**/ops.v1.IncidentService/WatchTimeline')
  await expect(ravi.getByTestId('live')).toHaveText('Live', { timeout: 15_000 })
  await expect(ravi.locator('.timeline')).toContainText('Posted while ravi was offline')
  await expect(ravi.locator('.timeline li')).toHaveCount(2) // opened + the note, no duplicates
})

test('phone width, dark mode: one column, nothing scrolls sideways', async ({ browser, request }) => {
  const [id] = await ids(request, 'ACKNOWLEDGED')
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })).newPage()
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue as asha' }).click()
  await open(page, id)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).toBe('rgb(18, 20, 24)') // the dark --bg
  await page.locator('.detail').screenshot({ path: 'results/phone-dark-detail.png' })
})
