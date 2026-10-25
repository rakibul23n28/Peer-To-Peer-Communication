import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} /> }
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} /> }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} /> }
export function Heading({children,className}:{children:React.ReactNode;className?:string}) { return <h1 className={className}>{children}</h1> }
