import { useState } from 'react';
import { supabase } from '../../utils/supabase/client';
import { ensureWelcomePackage } from '../lib/loyalty-supabase';
import { applyReferralCodeForSignup } from '../lib/member-lifecycle';

const WELCOME_NOTICE_STORAGE_KEY = 'centralperk-welcome-notice';

interface Member {
  id: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthdate: string;
  currentPointsBalance: number;
  createdAt: string;
}

export function RegistrationCard() {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    birthdate: '',
    password: '',
    referralCode: typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("ref") || "" : "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [registeredMember, setRegisteredMember] = useState<Member | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const getDuplicateMessage = (emailExists: boolean, phoneExists: boolean) => {
    if (emailExists && phoneExists) {
      return 'A user with that email and phone number already exists.';
    }

    if (emailExists) {
      return 'Duplicate email.';
    }

    if (phoneExists) {
      return 'Duplicate number.';
    }

    return null;
  };

  const buildReadableErrorMessage = (rawError: unknown) => {
    const errorText =
      typeof rawError === 'string'
        ? rawError
        : rawError && typeof rawError === 'object'
          ? [
              'message' in rawError ? String(rawError.message ?? '') : '',
              'details' in rawError ? String(rawError.details ?? '') : '',
              'hint' in rawError ? String(rawError.hint ?? '') : '',
              JSON.stringify(rawError),
            ]
              .filter(Boolean)
              .join(' ')
          : '';

    if (errorText.includes('A user with that email and phone number already exists.')) {
      return 'A user with that email and phone number already exists.';
    }

    if (errorText.includes('Duplicate email.') || errorText.includes('Email already registered')) {
      return 'Duplicate email.';
    }

    if (
      errorText.includes('Duplicate number.') ||
      errorText.includes('Phone number already registered') ||
      errorText.includes('This phone number is already registered')
    ) {
      return 'Duplicate number.';
    }

    if (
      errorText.includes('row-level security policy') ||
      errorText.includes('duplicate key') ||
      errorText.includes('already exists') ||
      errorText.includes('already registered')
    ) {
      return 'A user with that email and phone number already exists.';
    }

    return errorText || 'Registration failed. Please try again.';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);
    setRegisteredMember(null);

    try {
      const normalizedEmail = formData.email.trim().toLowerCase();
      const normalizedPhone = formData.phone.trim();

      // Pre-check email and phone before auth signup to prevent duplicate registrations.
      const { data: existingMembers, error: existingMembersError } = await supabase
        .from('loyalty_members')
        .select('email, phone')
        .or(`email.ilike.${normalizedEmail},phone.eq.${normalizedPhone}`);

      if (existingMembersError) {
        throw existingMembersError;
      }

      const emailExists = (existingMembers ?? []).some(
        (member) => member.email?.trim().toLowerCase() === normalizedEmail
      );
      const phoneExists = (existingMembers ?? []).some(
        (member) => member.phone?.trim() === normalizedPhone
      );
      const duplicateMessage = getDuplicateMessage(emailExists, phoneExists);

      if (duplicateMessage) {
        throw new Error(duplicateMessage);
      }

      // Create auth user after pre-check succeeds.
      const { error: signUpError } = await supabase.auth.signUp({
        email: normalizedEmail,
        password: formData.password,
        options: {
          emailRedirectTo: `${window.location.origin}/home`,
          data: {
            first_name: formData.firstName,
            last_name: formData.lastName,
            birthdate: formData.birthdate,
          },
        },
      });

      if (signUpError) {
        throw signUpError;
      }

      // SCRUM-15 (Create member registration API): Using a serverless architecture. This Supabase client-side SDK handles the direct, secure database insertion, replacing the need for a traditional Express routing layer.
      // Insert member profile after auth signup.
      const { data: newMember, error: insertError } = await supabase
        .from('loyalty_members')
        .insert([
          {
            first_name: formData.firstName,
            last_name: formData.lastName,
            email: formData.email,
            phone: formData.phone,
            birthdate: formData.birthdate,
            points_balance: 0,
            tier: 'Bronze',
          },
        ])
        .select()
        .single();

      if (insertError) {
        throw insertError;
      }

      const welcomeResult = await ensureWelcomePackage(newMember.member_number, newMember.email);
      const memberPointsBalance = Number(welcomeResult.newBalance ?? newMember.points_balance ?? 0);

      if (formData.referralCode.trim()) {
        const referral = await applyReferralCodeForSignup({
          referralCode: formData.referralCode.trim(),
          refereeMemberId: String(newMember.member_number),
          refereeEmail: String(newMember.email),
        });
        if (!referral.applied) {
          setMessage({
            type: 'error',
            text: 'Registration succeeded, but referral code was invalid or not applicable.',
          });
        }
      }

      // Update state with new member data
      setMessage({
        type: 'success',
        text: welcomeResult.granted
          ? 'Registration successful! Welcome package applied. You can now log in.'
          : 'Registration successful! Welcome to our loyalty program. You can now log in.',
      });

      setRegisteredMember({
        id: String(newMember.id ?? newMember.member_id ?? ''),
        memberNumber: newMember.member_number,
        firstName: newMember.first_name,
        lastName: newMember.last_name,
        email: newMember.email,
        phone: newMember.phone,
        birthdate: formData.birthdate,
        currentPointsBalance: memberPointsBalance,
        createdAt: newMember.enrollment_date,
      });

      if (welcomeResult.granted) {
        localStorage.setItem(
          WELCOME_NOTICE_STORAGE_KEY,
          JSON.stringify({
            memberNumber: newMember.member_number,
            grantedAt: new Date().toISOString(),
          })
        );
      }

      // Reset form
      setFormData({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        birthdate: '',
        password: '',
        referralCode: '',
      });

      console.log('Member registered:', newMember);
    } catch (error) {
      console.error('Registration error:', error);

      setMessage({
        type: 'error',
        text: buildReadableErrorMessage(error),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full bg-white rounded-3xl shadow-2xl overflow-hidden" style={{ fontFamily: "'Poppins', sans-serif" }}>
      <div className="flex flex-col md:flex-row">
        {/* Left Side - Branded Area */}
        <div className="w-full md:w-2/5 bg-gradient-to-br from-[#0f172a] to-[#1e293b] p-12 flex flex-col justify-center text-white">
          <div className="mb-8">
            <div className="w-16 h-16 bg-[#1bb9d3] rounded-2xl flex items-center justify-center mb-6">
              <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
            </div>
            <h2 className="text-4xl font-bold mb-4">Join Our Program</h2>
            <p className="text-gray-300 text-lg">Create your account and start earning rewards today.</p>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-[#1bb9d3] rounded-full"></div>
              <span className="text-sm text-gray-300">Instant member number</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-[#1bb9d3] rounded-full"></div>
              <span className="text-sm text-gray-300">Earn points on every purchase</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-[#1bb9d3] rounded-full"></div>
              <span className="text-sm text-gray-300">Exclusive member offers</span>
            </div>
          </div>
        </div>

        {/* Right Side - Registration Form */}
        <div className="w-full md:w-3/5 p-12">
          <h1 className="mb-2 text-3xl font-semibold text-gray-800">
            Create Account
          </h1>
          <p className="mb-8 text-gray-500">Fill in your details to get started</p>
          
          {message && (
            <div
              className={`mb-6 p-4 rounded-xl ${
                message.type === 'success'
                  ? 'bg-[#f5f7fb] text-[#1A2B47] border border-[#1A2B47]/30'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {message.text}
            </div>
          )}

          {registeredMember && (
            <div className="mb-6 p-5 rounded-xl bg-[#1A2B47] text-white">
              <p className="text-sm opacity-90 mb-1">Your Member Number</p>
              <p className="text-2xl font-semibold mb-3">
                {registeredMember.memberNumber}
              </p>
              <div className="text-sm opacity-90">
                <p>Points Balance: <span className="font-semibold">{registeredMember.currentPointsBalance}</span></p>
              </div>
            </div>
          )}
          
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Two-column grid for name fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="firstName" className="block mb-2 text-gray-700 font-medium">
                  First Name
                </label>
                <input
                  type="text"
                  id="firstName"
                  name="firstName"
                  value={formData.firstName}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                  placeholder="John"
                  required
                />
              </div>

              <div>
                <label htmlFor="lastName" className="block mb-2 text-gray-700 font-medium">
                  Last Name
                </label>
                <input
                  type="text"
                  id="lastName"
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                  placeholder="Doe"
                  required
                />
              </div>
            </div>

            {/* Two-column grid for email and phone */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="email" className="block mb-2 text-gray-700 font-medium">
                  Email Address
                </label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                  placeholder="your.email@example.com"
                  required
                />
              </div>

              <div>
                <label htmlFor="phone" className="block mb-2 text-gray-700 font-medium">
                  Phone Number
                </label>
                <input
                  type="tel"
                  id="phone"
                  name="phone"
                  value={formData.phone}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                  placeholder="(555) 123-4567"
                  required
                />
              </div>
            </div>

            {/* Birthdate field - full width */}
            <div>
              <label htmlFor="birthdate" className="block mb-2 text-gray-700 font-medium">
                Birthdate
              </label>
              <input
                type="date"
                id="birthdate"
                name="birthdate"
                value={formData.birthdate}
                onChange={handleChange}
                className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                required
              />
            </div>

            {/* Password field - full width */}
            <div>
              <label htmlFor="password" className="block mb-2 text-gray-700 font-medium">
                Password
              </label>
              <input
                type="password"
                id="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                placeholder="Minimum 6 characters"
                required
                minLength={6}
              />
            </div>

            <div>
              <label htmlFor="referralCode" className="block mb-2 text-gray-700 font-medium">
                Referral Code (Optional)
              </label>
              <input
                type="text"
                id="referralCode"
                name="referralCode"
                value={formData.referralCode}
                onChange={handleChange}
                className="w-full px-4 py-3 bg-[#dbe4f2] rounded-xl border border-transparent focus:outline-none focus:ring-2 focus:ring-[#1bb9d3] focus:border-transparent transition-all"
                placeholder="REF000123"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-[#1bb9d3] text-white py-3.5 rounded-xl hover:bg-[#18a9c0] transition-colors duration-200 mt-6 disabled:opacity-50 disabled:cursor-not-allowed font-semibold shadow-lg shadow-[#1bb9d3]/20"
            >
              {isSubmitting ? 'Registering...' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
