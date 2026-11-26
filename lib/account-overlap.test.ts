import { describe, it, expect } from 'vitest'
import { accountOverlap, mailboxKey, sameConfirmedMailbox } from './account-overlap'

const account = (over: Partial<Parameters<typeof accountOverlap>[0]> = {}) => ({
  name: 'Someone',
  email: null,
  discordHandle: null,
  signalNumber: null,
  whatsappNumber: null,
  ...over,
})

describe('accountOverlap', () => {
  it('finds a name the same but for case, accents and spacing', () => {
    expect(
      accountOverlap(account({ name: ' Zoë  Brown' }), account({ name: 'zoe brown' })),
    ).toEqual(['name'])
    expect(accountOverlap(account({ name: 'Ann' }), account({ name: 'Anne' }))).toEqual([])
  })

  it('finds the same Discord handle or phone number, across Signal and WhatsApp', () => {
    expect(
      accountOverlap(
        account({ name: 'A', discordHandle: ' Same#1 ' }),
        account({ name: 'B', discordHandle: 'same#1' }),
      ),
    ).toEqual(['discord'])
    expect(
      accountOverlap(
        account({ name: 'A', signalNumber: '+44 7700 900123' }),
        account({ name: 'B', whatsappNumber: '447700900123' }),
      ),
    ).toEqual(['phone'])
    // Too short a number says nothing.
    expect(
      accountOverlap(
        account({ name: 'A', signalNumber: '12345' }),
        account({ name: 'B', signalNumber: '12345' }),
      ),
    ).toEqual([])
  })

  it('finds one address an alias of the other', () => {
    expect(
      accountOverlap(
        account({ name: 'A', email: 'Jo.Smith+pauseai@gmail.com' }),
        account({ name: 'B', email: 'josmith@googlemail.com' }),
      ),
    ).toEqual(['email'])
    expect(
      accountOverlap(
        account({ name: 'A', email: 'jo.smith@example.org' }),
        account({ name: 'B', email: 'josmith@example.org' }),
      ),
    ).toEqual([])
    expect(mailboxKey(null)).toBeNull()
    expect(mailboxKey('no-at-sign')).toBeNull()
    expect(mailboxKey('@example.org')).toBeNull()
  })

  it('takes +tags and dots as aliases on Gmail only, and needs a name before the @', () => {
    expect(mailboxKey('sam+news@example.org')).toBe('sam+news@example.org')
    expect(mailboxKey('Sam.Smith+x@GoogleMail.com')).toBe('samsmith@gmail.com')
    expect(mailboxKey('+tag@gmail.com')).toBeNull()
    const confirmed = (email: string) => ({ email, emailConfirmed: true })
    expect(sameConfirmedMailbox(confirmed('jo@gmail.com'), confirmed('j.o+x@gmail.com'))).toBe(true)
    expect(
      sameConfirmedMailbox(confirmed('jo@gmail.com'), {
        email: 'jo@gmail.com',
        emailConfirmed: false,
      }),
    ).toBe(false)
    expect(
      sameConfirmedMailbox({ email: null, emailConfirmed: true }, confirmed('jo@gmail.com')),
    ).toBe(false)
  })
})
