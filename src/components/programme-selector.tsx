import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ALL_PROGRAMMES_VALUE } from "@/lib/programme-access";

interface ProgrammeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  programmes: readonly string[];
  includeAll?: boolean;
  allLabel?: string;
  placeholder?: string;
  triggerClassName?: string;
  disabled?: boolean;
}

const ProgrammeSelector = ({
  value,
  onValueChange,
  programmes,
  includeAll = false,
  allLabel = "All Programmes",
  placeholder = "Select programme",
  triggerClassName,
  disabled = false,
}: ProgrammeSelectorProps) => {
  const options = includeAll
    ? [ALL_PROGRAMMES_VALUE, ...programmes]
    : [...programmes];

  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((programme) => (
          <SelectItem key={programme} value={programme}>
            {programme === ALL_PROGRAMMES_VALUE ? allLabel : programme}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export default ProgrammeSelector;
