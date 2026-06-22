import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  savePhoto,
  getPhoto,
  deletePhoto,
  clearAllPhotos,
  prunePhotosExcept
} from '../pages/checkout/composables/useCheckoutPhotoStore.js'

const photo = (n) => ({ name: `${n}.jpg`, data: `data:image/jpeg;base64,${n}` })

describe('checkout gift photo store (IndexedDB)', () => {
  beforeEach(async () => { await clearAllPhotos() })

  it('round-trips a photo by cart-line key', async () => {
    await savePhoto('component:1', photo('a'))
    expect(await getPhoto('component:1')).toEqual(photo('a'))
  })

  it('returns null for a missing key', async () => {
    expect(await getPhoto('component:404')).toBeNull()
  })

  it('deletes a single photo', async () => {
    await savePhoto('component:1', photo('a'))
    await deletePhoto('component:1')
    expect(await getPhoto('component:1')).toBeNull()
  })

  it('prunePhotosExcept keeps only the given keys', async () => {
    await savePhoto('component:1', photo('a'))
    await savePhoto('component:2', photo('b'))
    await savePhoto('component:3', photo('c'))
    await prunePhotosExcept(['component:2'])
    expect(await getPhoto('component:1')).toBeNull()
    expect(await getPhoto('component:2')).toEqual(photo('b'))
    expect(await getPhoto('component:3')).toBeNull()
  })

  it('clearAllPhotos removes everything', async () => {
    await savePhoto('component:1', photo('a'))
    await savePhoto('component:2', photo('b'))
    await clearAllPhotos()
    expect(await getPhoto('component:1')).toBeNull()
    expect(await getPhoto('component:2')).toBeNull()
  })

  it('ignores empty keys without throwing', async () => {
    await expect(savePhoto('', photo('a'))).resolves.toBeUndefined()
    expect(await getPhoto('')).toBeNull()
  })
})

describe('checkout gift photo store — graceful fallback when IndexedDB is unavailable', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('no-ops (returns null, never throws) when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(savePhoto('component:1', photo('a'))).resolves.toBeUndefined()
    expect(await getPhoto('component:1')).toBeNull()
    await expect(deletePhoto('component:1')).resolves.toBeUndefined()
    await expect(clearAllPhotos()).resolves.toBeUndefined()
    await expect(prunePhotosExcept(['component:1'])).resolves.toBeUndefined()
  })
})
