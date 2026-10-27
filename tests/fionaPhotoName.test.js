import { describe, it, expect } from 'vitest'
import { headshotFileName } from '../server/utils/fiona/photoName.js'

describe('headshotFileName', () => {
  it('names a headshot R_Firstname_Lastname.jpg, the convention of the headshots in the media library', () => {
    expect(headshotFileName('Mari', 'Maasikas')).toBe('R_Mari_Maasikas.jpg')
  })

  it('keeps the letters of the name as written, accents included', () => {
    expect(headshotFileName('Tõnis', 'Pill')).toBe('R_Tõnis_Pill.jpg')
    expect(headshotFileName('Vėjūnė', 'Dūdėnienė')).toBe('R_Vėjūnė_Dūdėnienė.jpg')
  })

  it('turns spaces into underscores and drops characters that do not belong in a file name', () => {
    expect(headshotFileName('Sir Christopher', 'Hampton')).toBe('R_Sir_Christopher_Hampton.jpg')
    expect(headshotFileName('Carmen L.', 'Vicencio')).toBe('R_Carmen_L_Vicencio.jpg')
    expect(headshotFileName('A/B', 'C:D?')).toBe('R_A_B_C_D.jpg')
    expect(headshotFileName('  Mari  ', ' Maasikas ')).toBe('R_Mari_Maasikas.jpg')
  })

  it('copes with a single name and with none', () => {
    expect(headshotFileName('Cher', null)).toBe('R_Cher.jpg')
    expect(headshotFileName(null, 'Madonna')).toBe('R_Madonna.jpg')
    expect(headshotFileName('', '', 'abc-123')).toBe('R_abc-123.jpg')
  })
})
