import { prisma } from './prisma'

const byName = new Intl.Collator('en')

/** Every country, enabled or not, by name; sorted here so the database's collation is moot. */
export async function listCountries() {
  const countries = await prisma.country.findMany({
    select: { code: true, name: true, enabled: true },
  })
  return countries.sort((a, b) => byName.compare(a.name, b.name))
}

/** How a stored country is shown: its name, or the value itself when it is not listed. */
export async function countryName(code: string): Promise<string> {
  return (await prisma.country.findUnique({ where: { code } }))?.name ?? code
}

export async function isEnabledCountry(code: string): Promise<boolean> {
  return (await prisma.country.findUnique({ where: { code } }))?.enabled ?? false
}
