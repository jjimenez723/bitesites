import React from 'react';
import { Link } from 'react-router-dom';
import { LegalLayout, Section } from './LegalLayout';
import { LEGAL } from './legal-details';

const SECTIONS = [
  ['agreement', 'Agreement to these Terms'],
  ['services', 'What we provide'],
  ['eligibility', 'Eligibility'],
  ['accounts', 'Accounts and the client portal'],
  ['engagements', 'Client engagements, quotes and fees'],
  ['acceptable-use', 'Acceptable use'],
  ['ai', 'AI features and the Voice AI demo'],
  ['ip', 'Intellectual property'],
  ['submissions', 'Your submissions and feedback'],
  ['third-party', 'Third-party services and links'],
  ['disclaimers', 'Disclaimers'],
  ['liability', 'Limitation of liability'],
  ['indemnity', 'Indemnification'],
  ['termination', 'Suspension and termination'],
  ['disputes', 'Governing law and dispute resolution'],
  ['changes', 'Changes to these Terms'],
  ['contact', 'How to reach us']
];

export default function Terms() {
  return (
    <LegalLayout
      title="Terms of Service"
      intro={`These Terms govern your use of ${LEGAL.site} and any services you request through it. Please read them carefully — they include a limitation of liability and describe how disputes are resolved.`}
      sections={SECTIONS}
    >
      <Section id="agreement" heading="1. Agreement to these Terms">
        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) form a binding agreement between you and{' '}
          {LEGAL.entity} (&ldquo;{LEGAL.brand},&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
          &ldquo;our&rdquo;) and govern your access to and use of {LEGAL.siteUrl}, its subdomains, and
          the tools, forms, demos and client portal made available through it (together, the
          &ldquo;Site&rdquo;).
        </p>
        <p>
          By using the Site, submitting a form, or creating an account, you agree to these Terms and
          to our <Link to="/privacy">Privacy Policy</Link>. If you do not agree, please do not use
          the Site.
        </p>
        <p>
          If you are accepting these Terms on behalf of a company or other organisation, you
          represent that you have authority to bind that organisation, and &ldquo;you&rdquo; refers
          to that organisation.
        </p>
      </Section>

      <Section id="services" heading="2. What we provide">
        <p>
          {LEGAL.brand} is a digital agency. Through the Site we describe and offer services
          including web development, social media management, AI automation, and custom Voice AI
          receptionists and phone agents.
        </p>
        <p>
          The Site itself is primarily informational. It lets you learn about our services, view
          examples of our work, interact with product demos, and submit an enquiry so that we can
          follow up with you. Nothing on the Site is an offer capable of acceptance, and submitting a
          form does not create an agency engagement or oblige either of us to enter into one.
        </p>
      </Section>

      <Section id="eligibility" heading="3. Eligibility">
        <p>
          You must be at least 18 years old and capable of forming a binding contract to use the Site.
          The Site is directed at businesses and is not intended for children. We do not knowingly
          collect information from anyone under 18.
        </p>
      </Section>

      <Section id="accounts" heading="4. Accounts and the client portal">
        <p>
          Some areas of the Site require an account. When you register you agree to provide accurate
          information and to keep it current.
        </p>
        <ul>
          <li>
            <strong>Approval is required.</strong> Creating an account does not by itself grant access
            to any client data. New accounts begin in a pending state and are reviewed by us before
            any access is granted.
          </li>
          <li>
            <strong>You are responsible for your credentials.</strong> Keep your password
            confidential, do not share your account, and notify us promptly at{' '}
            <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> if you believe your
            account has been accessed without authorisation.
          </li>
          <li>
            <strong>One account per person.</strong> Do not register on behalf of anyone else or
            impersonate another person or organisation.
          </li>
          <li>
            <strong>Administrator accounts.</strong> Administrative access is granted only by us, to
            our personnel and authorised representatives. Any attempt to obtain administrative access
            you have not been granted is a material breach of these Terms.
          </li>
        </ul>
        <p>
          We may suspend or close an account at any time if we reasonably believe it has been used in
          breach of these Terms or presents a security risk.
        </p>
      </Section>

      <Section id="engagements" heading="5. Client engagements, quotes and fees">
        <p>
          Pricing shown on the Site is indicative and provided for general guidance. It is not a
          quote and is subject to change without notice.
        </p>
        <p>
          Paid work begins only under a separate written agreement — a proposal, statement of work,
          or order form signed or otherwise accepted by both parties (an &ldquo;Engagement
          Agreement&rdquo;). The Engagement Agreement governs scope, deliverables, timelines, fees,
          payment terms, ownership of deliverables, and any warranties. Where an Engagement Agreement
          conflicts with these Terms, the Engagement Agreement controls for that engagement.
        </p>
      </Section>

      <Section id="acceptable-use" heading="6. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>use the Site in violation of any applicable law or regulation;</li>
          <li>
            submit false, misleading or fraudulent information, including submitting enquiry forms in
            someone else&rsquo;s name or with contact details you are not authorised to use;
          </li>
          <li>
            send automated, bulk or repetitive submissions, or otherwise attempt to overload,
            disrupt, or degrade the Site or its supporting infrastructure;
          </li>
          <li>
            probe, scan, or test the vulnerability of the Site, or breach or circumvent any security
            or authentication measure;
          </li>
          <li>
            access, tamper with, or use non-public areas of the Site, or data belonging to other users
            or clients;
          </li>
          <li>
            scrape, crawl, or harvest data from the Site by automated means without our prior written
            permission;
          </li>
          <li>
            upload or transmit malware, or any material that is unlawful, defamatory, harassing, or
            infringing;
          </li>
          <li>
            reverse engineer, decompile, or attempt to derive the source code of any part of the Site
            except to the extent that restriction is prohibited by law.
          </li>
        </ul>
      </Section>

      <Section id="ai" heading="7. AI features and the Voice AI demo">
        <p>
          The Site includes AI-assisted features, including a guided chat assistant and an
          interactive Voice AI receptionist demo.
        </p>
        <ul>
          <li>
            <strong>Demonstration only.</strong> These features are provided to illustrate our
            capabilities. They are not professional, legal, financial, or technical advice, and should
            not be relied upon for any decision.
          </li>
          <li>
            <strong>AI output can be wrong.</strong> AI systems can produce inaccurate, incomplete or
            unexpected results. You are responsible for independently verifying anything an AI feature
            tells you.
          </li>
          <li>
            <strong>Microphone access and call recording.</strong> The Voice AI demo places a real
            voice call and asks your permission to use your microphone. Your speech is transmitted to
            our voice platform provider to power the conversation, and the call may be recorded and
            transcribed. By starting a call you consent to that recording. Do not share sensitive
            information during the demo, and do not start a call if anyone else can be heard who has
            not consented. You can decline the permission prompt or end the call at any time. See our{' '}
            <Link to="/privacy">Privacy Policy</Link> for detail.
          </li>
        </ul>
      </Section>

      <Section id="ip" heading="8. Intellectual property">
        <p>
          The Site and its contents — including text, graphics, logos, the {LEGAL.brand} name and
          marks, illustrations, layout, code, and the selection and arrangement of all of it — are
          owned by {LEGAL.entity} or our licensors and are protected by copyright, trademark and
          other laws.
        </p>
        <p>
          We grant you a limited, personal, non-exclusive, non-transferable, revocable licence to
          access and view the Site for your own internal business purposes. All rights not expressly
          granted are reserved. You may not copy, reproduce, republish, distribute, modify, or create
          derivative works from the Site without our prior written consent.
        </p>
        <p>
          Portfolio work shown on the Site may include the trademarks and materials of our clients,
          which remain the property of their respective owners. Ownership of work we produce under an
          Engagement Agreement is determined by that agreement.
        </p>
      </Section>

      <Section id="submissions" heading="9. Your submissions and feedback">
        <p>
          You retain ownership of the information you submit through the Site. By submitting it, you
          grant us a non-exclusive, worldwide, royalty-free licence to use, store and process that
          information for the purpose of responding to you, providing our services, and operating and
          improving the Site.
        </p>
        <p>
          You represent that you have the right to share the information you submit and that it does
          not infringe anyone&rsquo;s rights or violate any law or duty of confidentiality.
        </p>
        <p>
          If you send us feedback, suggestions or ideas about our services, you agree we may use them
          without restriction, attribution, or compensation to you.
        </p>
      </Section>

      <Section id="third-party" heading="10. Third-party services and links">
        <p>
          The Site relies on third-party infrastructure — including Google Firebase and Google Cloud
          for data storage and authentication, GoHighLevel (LeadConnector) for the Voice AI demo and
          customer relationship management, and Google Fonts for typography — and may link to
          third-party websites. We do not control third-party services and are not responsible for
          their content, policies, availability, or practices. Your use of a third-party service is
          governed by that provider&rsquo;s terms.
        </p>
      </Section>

      <Section id="disclaimers" heading="11. Disclaimers">
        <p className="legal-caps">
          The Site is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranty
          of any kind. To the fullest extent permitted by law, {LEGAL.entity} disclaims all
          warranties, express, implied or statutory, including any implied warranties of
          merchantability, fitness for a particular purpose, title, and non-infringement.
        </p>
        <p>
          We do not warrant that the Site will be uninterrupted, timely, secure, or error-free, that
          defects will be corrected, or that any content — including anything generated by an AI
          feature — is accurate, complete, or current. Any material you access through the Site is
          accessed at your own discretion and risk.
        </p>
        <p>
          Some jurisdictions do not allow the exclusion of certain warranties, so parts of this
          section may not apply to you.
        </p>
      </Section>

      <Section id="liability" heading="12. Limitation of liability">
        <p className="legal-caps">
          To the fullest extent permitted by law, {LEGAL.entity} and its officers, employees,
          contractors and agents will not be liable for any indirect, incidental, special,
          consequential, exemplary or punitive damages, or for any loss of profits, revenue, data,
          goodwill, or business opportunity, arising out of or relating to your use of the Site —
          whether based in contract, tort (including negligence), strict liability, or any other
          theory, and even if we have been advised of the possibility of such damages.
        </p>
        <p className="legal-caps">
          Our total aggregate liability arising out of or relating to the Site or these Terms will not
          exceed the greater of (a) the total amount you paid us in the twelve months preceding the
          event giving rise to the claim, or (b) one hundred US dollars (US$100).
        </p>
        <p>
          These limitations apply to your use of the Site. Liability arising under an Engagement
          Agreement is governed by that agreement. Nothing in these Terms excludes liability that
          cannot lawfully be excluded, including for fraud, fraudulent misrepresentation, or death or
          personal injury caused by negligence. Some jurisdictions do not allow certain limitations,
          so parts of this section may not apply to you.
        </p>
      </Section>

      <Section id="indemnity" heading="13. Indemnification">
        <p>
          You agree to indemnify and hold harmless {LEGAL.entity} and its officers, employees,
          contractors and agents from any claims, liabilities, damages, losses and expenses —
          including reasonable legal fees — arising out of or connected with your use of the Site,
          your submissions, or your breach of these Terms or of any law or third-party right.
        </p>
      </Section>

      <Section id="termination" heading="14. Suspension and termination">
        <p>
          We may suspend, restrict, or terminate your access to the Site or an account at any time,
          with or without notice, if we reasonably believe you have breached these Terms, or to
          protect the Site, our clients, or third parties. You may stop using the Site at any time,
          and may ask us to close your account by emailing{' '}
          <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.
        </p>
        <p>
          Sections that by their nature should survive termination — including intellectual property,
          disclaimers, limitation of liability, indemnification, and governing law — will survive.
        </p>
      </Section>

      <Section id="disputes" heading="15. Governing law and dispute resolution">
        <p>
          These Terms and any dispute arising out of or relating to them or the Site are governed by
          the laws of the State of {LEGAL.governingState}, and applicable United States federal law,
          without regard to conflict-of-laws principles.
        </p>
        <p>
          <strong>Informal resolution first.</strong> If you have a dispute with us, please contact us
          at <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> first. Most concerns
          can be resolved quickly. We each agree to attempt in good faith to resolve a dispute
          informally for at least 30 days before starting formal proceedings.
        </p>
        <p>
          <strong>Venue.</strong> If a dispute cannot be resolved informally, you and we agree to the
          exclusive jurisdiction and venue of {LEGAL.courtsVenue}, and each of us consents to personal
          jurisdiction there.
        </p>
      </Section>

      <Section id="changes" heading="16. Changes to these Terms">
        <p>
          We may update these Terms from time to time. When we do, we will revise the &ldquo;Last
          updated&rdquo; date at the top of this page. If a change is material, we will make
          reasonable efforts to provide additional notice — for example, a notice on the Site or an
          email to account holders. Your continued use of the Site after a change takes effect means
          you accept the revised Terms.
        </p>
      </Section>

      <Section id="contact" heading="17. How to reach us">
        <p>
          These Terms are entered into with {LEGAL.entity}. If any provision is found unenforceable,
          the rest remains in effect. Our failure to enforce a provision is not a waiver of it. You
          may not assign these Terms without our consent; we may assign them in connection with a
          merger, acquisition, or sale of assets.
        </p>
        <address className="legal-address">
          {LEGAL.entity}
          <br />
          {LEGAL.mailingAddress}
          <br />
          <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>
        </address>
      </Section>
    </LegalLayout>
  );
}
