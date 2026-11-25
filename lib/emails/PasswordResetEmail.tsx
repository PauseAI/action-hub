import { Heading, Section, Text } from '@react-email/components'
import { EmailLayout } from './components/Layout'
import { EmailButton } from './components/EmailButton'
import { EmailFooter } from './components/Footer'

export type PasswordResetEmailProps = {
  resetUrl: string
  name: string
  appUrl: string
  /** The account has no password yet, so this link sets its first one. */
  firstPassword?: boolean
}

export function PasswordResetEmail({
  resetUrl,
  name,
  appUrl,
  firstPassword = false,
}: PasswordResetEmailProps) {
  const button = firstPassword ? 'Set Password' : 'Reset Password'
  return (
    <EmailLayout>
      <Heading as="h2">{firstPassword ? 'Set a Password' : 'Reset Your Password'}</Heading>
      <Text>{`Hi ${name},`}</Text>
      {firstPassword ? (
        <Text>
          We received a request to set a password for your Action Hub account, which signs in with
          Google. Click the button below to choose one. Once it&apos;s set you&apos;ll be signed out
          everywhere, then you can sign in with Google or your password.
        </Text>
      ) : (
        <Text>
          We received a request to reset your password for your Action Hub account. Click the button
          below to choose a new password:
        </Text>
      )}
      <Section style={{ textAlign: 'center', margin: '32px 0' }}>
        <EmailButton href={resetUrl}>{button}</EmailButton>
      </Section>
      <Text>
        This link will expire in <strong>1 hour</strong>.
      </Text>
      <Text>
        {firstPassword
          ? "If you didn't request this, you can safely ignore this email. No password will be set."
          : "If you didn't request this, you can safely ignore this email. Your password won't be changed."}
      </Text>
      <EmailFooter appUrl={appUrl} buttons={[{ label: button, url: resetUrl }]} />
    </EmailLayout>
  )
}
