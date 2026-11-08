import { describe, expect, it } from 'vitest'
import { editionFeatures, effectiveEdition, productName } from './edition'

describe('effectiveEdition', () => {
  it('is corp when either the renderer build or the backend says so', () => {
    expect(effectiveEdition('standard', 'standard')).toBe('standard')
    expect(effectiveEdition('corp', 'standard')).toBe('corp')
    expect(effectiveEdition('standard', 'corp')).toBe('corp')
  })
})

describe('edition details', () => {
  it('names the product and hides compiled-out features in corp', () => {
    expect(productName('standard')).toBe('Swarmterm GN')
    expect(productName('corp')).toBe('Swarmterm GN Corp')
    expect(editionFeatures('standard')).toEqual({ companion: true, modelDownload: true })
    expect(editionFeatures('corp')).toEqual({ companion: false, modelDownload: false })
  })
})
