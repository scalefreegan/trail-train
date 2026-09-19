import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'

/**
 * What a printable document actually puts on paper.
 *
 * The printable documents in this app (the 3×5 cards and the crew sheet) are
 * light-on-dark components forced light for print: `@media print` flips
 * `color-scheme`, blanks the app background and hides `#root` so only the
 * portalled sheet survives. Every one of those rules is invisible on screen,
 * which is exactly how the bug the interactive rounds kept finding gets in —
 * a card that looks right in the browser and comes out of the printer as a
 * near-black rectangle, or a sheet that paginates onto page 2 over the app's
 * own dark body colour.
 *
 * The only honest test of that is to render the page the way a printer would
 * and look at the pixels. So: `page.pdf()` (Playwright renders it in `print`
 * media by default), ghostscript rasterises each page to raw greyscale, and
 * we count how much of each page is light. A card that regressed to the dark
 * palette does not fail by a few percent — it fails by eighty.
 *
 * PGM (`-sDEVICE=pgmraw`) rather than PNG on purpose: P5 is a three-line
 * ASCII header followed by one byte per pixel, so the suite needs no image
 * decoder and no new dependency to read it.
 */

/** A pixel at or above this is "light" — paper, not ink. */
const LIGHT = 200

/** 150 dpi: close enough to what a printer does that a 9px caption is still
    a few thin strokes rather than a grey smear — at 36 dpi every glyph blurs
    over its whole cell and an ordinary card reads as 80 % ink. */
const DPI = 150

export type PaperPage = {
  /** 1-based page number as ghostscript emitted it. */
  page: number
  width: number
  height: number
  /** Share of pixels at or above the light threshold, 0–1. */
  lightPct: number
}

/** Is ghostscript on PATH? The print check is skipped, loudly, without it. */
export function hasGhostscript(): boolean {
  const r = spawnSync('gs', ['--version'], { stdio: 'ignore' })
  return r.status === 0
}

/**
 * Print `page` to PDF and measure every resulting sheet.
 *
 * `preferCSSPageSize` matters: RunnerCard/FuelCard/DropBagCard each inject
 * `@page { size: 5in 3in }` while they are mounted, and without this flag the
 * PDF comes out Letter-sized with the card in one corner — which would make
 * the rest of the sheet "light" for entirely the wrong reason.
 */
export async function printPages(page: Page, label: string): Promise<PaperPage[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-train-print-'))
  try {
    const pdf = path.join(dir, `${label}.pdf`)
    await page.pdf({ path: pdf, printBackground: true, preferCSSPageSize: true })
    execFileSync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pgmraw', `-r${DPI}`,
      `-sOutputFile=${path.join(dir, 'p-%d.pgm')}`,
      pdf,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    const pages = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.pgm'))
      .map((f) => ({ n: Number(/p-(\d+)\.pgm$/.exec(f)![1]), f }))
      .sort((a, b) => a.n - b.n)
    if (pages.length === 0) throw new Error(`ghostscript produced no pages for ${label}`)
    return pages.map(({ n, f }) => ({ page: n, ...measurePgm(fs.readFileSync(path.join(dir, f))) }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Parse a binary PGM (P5) and return its size and light fraction.
 *
 * The header is `P5`, width, height and maxval as whitespace-separated
 * tokens, `#` to end of line being a comment, and exactly one whitespace
 * byte between the maxval and the first pixel.
 */
export function measurePgm(buf: Buffer): { width: number; height: number; lightPct: number } {
  let i = 0
  const token = (): string => {
    for (;;) {
      while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++
      if (buf[i] === 0x23) { while (i < buf.length && buf[i] !== 0x0a) i++; continue }
      break
    }
    const start = i
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i++
    return buf.toString('latin1', start, i)
  }

  const magic = token()
  if (magic !== 'P5') throw new Error(`expected a binary PGM (P5), got ${JSON.stringify(magic)}`)
  const width = Number(token())
  const height = Number(token())
  const maxval = Number(token())
  if (maxval !== 255) throw new Error(`expected an 8-bit PGM, got maxval ${maxval}`)
  i++ // the single whitespace byte after the maxval

  const px = buf.subarray(i)
  const expected = width * height
  if (px.length < expected) throw new Error(`PGM is short: ${px.length} bytes for ${expected} pixels`)
  let light = 0
  for (let p = 0; p < expected; p++) if (px[p] >= LIGHT) light++
  return { width, height, lightPct: light / expected }
}

/** "p1 12.3% · p2 98.0%" — what a failure message needs to be readable. */
export function describePages(pages: PaperPage[]): string {
  return pages.map((p) => `p${p.page} ${(p.lightPct * 100).toFixed(1)}% (${p.width}×${p.height})`).join(' · ')
}
