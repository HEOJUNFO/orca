import { expect, it, vi } from 'vitest'
import { listFilesystemMarkdownDocuments } from './filesystem-markdown-listing'

it('uses a native markdown capability without requiring unrelated provider methods', async () => {
  const documents = [
    { filePath: '/repo/docs/a.md', relativePath: 'docs/a.md', basename: 'a.md', name: 'a' }
  ]
  const listMarkdownDocuments = vi.fn(async () => documents)
  await expect(listFilesystemMarkdownDocuments({ listMarkdownDocuments }, '/repo')).resolves.toBe(
    documents
  )
  expect(listMarkdownDocuments).toHaveBeenCalledWith('/repo')
})

it('retains the path-list fallback for providers without native markdown listing', async () => {
  const listFiles = vi.fn(async () => ['b.mdx', 'ignored.ts', '../escape.md', 'a.md'])
  const documents = await listFilesystemMarkdownDocuments({ listFiles }, '/repo')
  expect(documents.map((document) => document.relativePath)).toEqual(['a.md', 'b.mdx'])
  expect(listFiles).toHaveBeenCalledWith('/repo')
})
