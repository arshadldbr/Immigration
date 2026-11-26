/**
 * Borderway International — Supabase client setup (EXAMPLE FILE)
 * ------------------------------------------------------------------
 * 1. Copy this file to `supabase-config.js` in the website folder.
 * 2. Replace the two placeholders below with the values from your
 *    Supabase project: Dashboard -> Settings -> API.
 *    - SUPABASE_URL: the "Project URL"
 *    - SUPABASE_ANON_KEY: the "anon public" key
 * 3. NEVER paste the "service_role" key here. It bypasses all security
 *    rules and must only ever live on a server (Edge Functions).
 *
 * This file uses the Supabase JS library v2 from a CDN, so the website
 * needs no build step. For a bundled site, install it instead:
 *   npm install @supabase/supabase-js
 * and change the import to:  import { createClient } from '@supabase/supabase-js';
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY-HERE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// Auth — sign up, sign in, sign out
// ---------------------------------------------------------------------------

/** Create an account. A profile row is made automatically by the database. */
export async function signUp({ email, password, fullName, phone }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, phone } },
  });
  if (error) throw error;
  return data.user; // may be null until the email is confirmed
}

/** Sign in with email + password. Works from any device. */
export async function signIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

/** Sign out on this device. */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** The currently signed-in user, or null. */
export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

/** Runs `callback` whenever the sign-in state changes (login, logout). */
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
}

// ---------------------------------------------------------------------------
// Leads — appointment / contact / free-assessment submissions
// Anyone may submit (signed in or not). user_id is filled in when signed in.
// ---------------------------------------------------------------------------

/**
 * Submit a lead. `submissionType` is one of:
 * 'Appointment' | 'Eligibility analysis' | 'Free assessment' | 'Contact'
 * `country` is 'Canada' or 'USA'. `visaType` is one of:
 * 'Visit' | 'Study' | 'Work' | 'Business' | 'Family' | 'Super Visa' | 'Refusal re-apply'
 */
export async function submitLead({ name, phone, email, country, visaType, submissionType, message }) {
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    user_id: user?.id ?? null,
    name,
    phone,
    email: email || null,
    country,
    visa_type: visaType,
    submission_type: submissionType || 'Free assessment',
    message: message || null,
  };
  // RLS note: INSERT ... RETURNING only returns rows the caller may also
  // SELECT. Anonymous visitors have no SELECT policy on leads, so asking
  // for the row back would return nothing for them. Only ask for the row
  // when signed in; anonymous submissions just confirm success.
  if (user) {
    const { data, error } = await supabase
      .from('leads')
      .insert(row)
      .select('id, status, created_at')
      .single();
    if (error) throw error;
    return data; // { id, status: 'New', created_at }
  }
  const { error } = await supabase.from('leads').insert(row);
  if (error) throw error;
  return { submitted: true };
}

// ---------------------------------------------------------------------------
// Assessments — eligibility-analysis submissions
// ---------------------------------------------------------------------------

/**
 * Submit an eligibility analysis. The result is filled in later by the
 * admin, or by the live-analysis Edge Function (see edge-function-outline.md).
 * Returns the created row; result/analysis_text will be empty until reviewed.
 */
export async function submitAssessment({
  leadId, country, visaType, age, education,
  workExperienceYears, ieltsScore, fundsCad, travelHistory, refusalHistory,
}) {
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    lead_id: leadId || null,
    user_id: user?.id ?? null,
    country,
    visa_type: visaType,
    age: age || null,
    education: education || null,
    work_experience_years: workExperienceYears ?? null,
    ielts_score: ieltsScore ?? null,
    funds_cad: fundsCad ?? null,
    travel_history: travelHistory || null,
    refusal_history: refusalHistory || null,
  };
  // Same RLS note as submitLead: only ask for the row back when signed in.
  if (user) {
    const { data, error } = await supabase
      .from('assessments')
      .insert(row)
      .select('id, created_at')
      .single();
    if (error) throw error;
    return data; // { id, created_at }
  }
  const { error } = await supabase.from('assessments').insert(row);
  if (error) throw error;
  return { submitted: true };
}

/** Read one assessment (owner or admin only — enforced by the database). */
export async function getAssessment(assessmentId) {
  const { data, error } = await supabase
    .from('assessments')
    .select('*')
    .eq('id', assessmentId)
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// My submissions — what the signed-in visitor sees on their account page
// ---------------------------------------------------------------------------

export async function getMyLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select('id, name, country, visa_type, submission_type, status, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getMyAssessments() {
  const { data, error } = await supabase
    .from('assessments')
    .select('id, country, visa_type, result, analysis_text, source_links, checked_at, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Documents — upload a file to the private `documents` bucket
// The visitor must be signed in. The file goes to:
//   documents/<user_id>/<lead_id>/<file_name>
// and one metadata row is written to the `documents` table.
// ---------------------------------------------------------------------------

export async function uploadDocument({ leadId, file }) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Please sign in before uploading documents.');

  const path = `${user.id}/${leadId}/${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from('documents')
    .insert({
      lead_id: leadId,
      user_id: user.id,
      file_name: file.name,
      file_path: path,
      file_type: file.type || null,
      file_size_bytes: file.size,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data; // { id }
}
