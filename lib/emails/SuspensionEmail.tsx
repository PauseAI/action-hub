import { Heading, Text } from '@react-email/components'
import { EmailLayout } from './components/Layout'
import { EmailFooter } from './components/Footer'

export type SuspensionEmailProps = {
  name: string
  /** True when the suspension is lifted. */
  lifted: boolean
  supportEmail: string
  appUrl: string
}

/** Tells a member their account was suspended, or that the suspension is lifted; never why. */
export function SuspensionEmail({ name, lifted, supportEmail, appUrl }: SuspensionEmailProps) {
  return (
    <EmailLayout>
      <Heading as="h2">
        {lifted
          ? 'Your Action Hub account is no longer suspended'
          : 'Your Action Hub account is suspended'}
      </Heading>
      <Text>{`Hi ${name},`}</Text>
      {lifted ? (
        <>
          <Text>
            Your account is no longer suspended, and everything is as you left it. You can sign in
            as usual.
          </Text>
          <Text>Thank you for your patience.</Text>
        </>
      ) : (
        <>
          <Text>
            Someone who helps run Action Hub has suspended your account for now. While it is
            suspended you can&apos;t sign in, and you won&apos;t get our usual emails about projects
            and tasks. Nothing has been deleted: your profile, your work and everything else is kept
            just as it is.
          </Text>
          <Text>
            If you&apos;d like to talk about it, or think this is a mistake, please write to{' '}
            <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and someone will get back to you.
          </Text>
        </>
      )}
      <EmailFooter appUrl={appUrl} />
    </EmailLayout>
  )
}
