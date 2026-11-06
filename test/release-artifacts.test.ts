import { afterEach, expect, it, vi } from 'vite-plus/test'
import { pendingReleaseFiles } from '../scripts/release-pending'

afterEach(() => vi.unstubAllGlobals())

it('resumes only missing artifacts and verifies the bytes already published', async () => {
    const artifacts = [
        { name: 'liti', version: '0.1.0', file: 'liti-0.1.0.tgz', integrity: 'sha512-core' },
        { name: '@litijs/blog', version: '0.1.0', file: 'blog-0.1.0.tgz', integrity: 'sha512-blog' },
    ]
    vi.stubGlobal(
        'fetch',
        vi
            .fn()
            .mockResolvedValueOnce(Response.json({ dist: { integrity: 'sha512-core' } }))
            .mockResolvedValueOnce(new Response(null, { status: 404 })),
    )
    expect(await pendingReleaseFiles(artifacts)).toEqual(['blog-0.1.0.tgz'])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ dist: { integrity: 'sha512-other' } })))
    await expect(pendingReleaseFiles(artifacts)).rejects.toThrow('Published bytes differ')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    await expect(pendingReleaseFiles(artifacts)).rejects.toThrow('HTTP 403')
})
